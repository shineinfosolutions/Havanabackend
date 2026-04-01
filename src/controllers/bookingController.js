const Booking = require("../models/Booking.js");
const Category = require("../models/Category.js");
const Room = require("../models/Room.js");
const { getAuditLogModel } = require('../models/AuditLogModel');
const mongoose = require('mongoose');
const cloudinary = require('../utils/cloudinary');

// Dynamic tax rates - can be modified as needed
const TAX_RATES = {
  cgstRate: 0.025, // 2.5%
  sgstRate: 0.025  // 2.5%
};

// Helper function to create audit log (non-blocking)
const createAuditLog = (action, recordId, userId, userRole, oldData, newData, req) => {
  // Run asynchronously without blocking main operation
  setImmediate(async () => {
    try {
      const AuditLog = await getAuditLogModel();
      await AuditLog.create({
        action,
        module: 'BOOKING',
        recordId,
        userId: userId || new mongoose.Types.ObjectId(),
        userRole: userRole || 'SYSTEM',
        oldData,
        newData,
        ipAddress: req?.ip || req?.connection?.remoteAddress,
        userAgent: req?.get('User-Agent')
      });
      console.log(`✅ Audit log created: ${action} for booking ${recordId}`);
    } catch (error) {
      console.error('❌ Audit log creation failed:', error);
    }
  });
};

// Upload base64 image to Cloudinary
const uploadBase64ToCloudinary = async (base64String) => {
  try {
    // Check if Cloudinary is properly configured
    if (!process.env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_API_KEY === 'your_api_key') {
      console.warn('Cloudinary not configured, skipping image upload');
      return base64String; // Return the base64 string as fallback
    }
    
    const result = await cloudinary.uploader.upload(base64String, {
      folder: 'havana-booking-media',
      transformation: [{ width: 800, height: 800, crop: 'limit' }]
    });
    return result.secure_url;
  } catch (error) {
    console.warn('Image upload failed, using base64 fallback:', error.message);
    return base64String; // Return the base64 string as fallback
  }
};

// 🔹 Generate sequential GRC number (resets on April 1st each financial year)
const generateGRC = async () => {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const financialYear = currentMonth >= 3 ? currentYear : currentYear - 1;
  const financialYearStart = new Date(financialYear, 3, 1, 0, 0, 0, 0);
  const financialYearEnd = new Date(financialYear + 1, 2, 31, 23, 59, 59, 999);

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const bookingsThisYear = await Booking.find({
      createdAt: { $gte: financialYearStart, $lte: financialYearEnd },
      grcNo: { $regex: /^GRC\d+$/ }
    }, { grcNo: 1 }).lean();

    let nextNumber = 1;
    if (bookingsThisYear.length > 0) {
      const maxNumber = Math.max(...bookingsThisYear.map(b => parseInt(b.grcNo.replace('GRC', ''), 10) || 0));
      nextNumber = maxNumber + 1;
    }

    const candidate = `GRC${nextNumber.toString().padStart(4, '0')}`;

    // Only check for collision within the SAME financial year (not globally)
    // GRC0001 from last year should not block GRC0001 this year
    const collision = await Booking.findOne({
      grcNo: candidate,
      createdAt: { $gte: financialYearStart, $lte: financialYearEnd }
    }, { _id: 1 }).lean();

    if (!collision) return candidate;
  }

  throw new Error('Failed to generate unique GRC after multiple attempts');
};



// Book a room for a category (single or multiple)
exports.bookRoom = async (req, res) => {
  try {
    const handleBooking = async (categoryId, selectedRooms, extraDetails = {}) => {
      const category = await Category.findById(categoryId);
      if (!category) throw new Error(`Category not found: ${categoryId}`);

      // If selectedRooms is provided, use those specific rooms
      let roomsToBook = [];
      if (selectedRooms && Array.isArray(selectedRooms) && selectedRooms.length > 0) {
        // Get the specific rooms that were selected
        const roomIds = selectedRooms.map(room => room._id);
        roomsToBook = await Room.find({ _id: { $in: roomIds } });
        
        if (roomsToBook.length !== selectedRooms.length) {
          throw new Error(`Some selected rooms not found`);
        }
        
        // Check for actual booking conflicts instead of just room status
        const checkIn = new Date(extraDetails.checkInDate + 'T00:00:00.000Z');
        const checkOut = new Date(extraDetails.checkOutDate + 'T23:59:59.999Z');
        
        for (const room of roomsToBook) {
          const conflictingBookings = await Booking.find({
            roomNumber: { $regex: new RegExp(`(^|,)\\s*${room.room_number}\\s*(,|$)`) },
            status: { $in: ['Booked', 'Checked In'] },
            isActive: true,
            checkInDate: { $lt: checkOut },
            checkOutDate: { $gt: checkIn }
          });
          
          if (conflictingBookings.length > 0) {
            throw new Error(`Room ${room.room_number} is not available for the selected dates`);
          }
        }
      } else {
        // Fallback to old behavior - get any available rooms
        const count = extraDetails.numberOfRooms || 1;
        
        // Check for actual availability based on booking conflicts
        const checkIn = new Date(extraDetails.checkInDate + 'T00:00:00.000Z');
        const checkOut = new Date(extraDetails.checkOutDate + 'T23:59:59.999Z');
        
        const overlappingBookings = await Booking.find({
          isActive: true,
          status: { $in: ['Booked', 'Checked In'] },
          checkInDate: { $lt: checkOut },
          checkOutDate: { $gt: checkIn }
        }).lean();
        
        const bookedRoomNumbers = [];
        overlappingBookings.forEach(booking => {
          if (booking.roomNumber) {
            const roomNums = booking.roomNumber.split(',').map(num => num.trim());
            bookedRoomNumbers.push(...roomNums);
          }
        });
        
        roomsToBook = await Room.find({ 
          categoryId: categoryId, 
          room_number: { $nin: bookedRoomNumbers }
        }).limit(count);
        
        if (roomsToBook.length < count) {
          throw new Error(`Not enough available rooms in ${category.name} for the selected dates`);
        }
      }

      const grcNo = await generateGRC();
      const bookedRoomNumbers = roomsToBook.map(room => room.room_number);

      // Calculate tax amounts using dynamic rates
      let taxableAmount = extraDetails.rate || 0; // Input rate is the taxable amount
      
      // Apply discount if provided
      if (extraDetails.discountPercent && extraDetails.discountPercent > 0) {
        const discountAmount = taxableAmount * (extraDetails.discountPercent / 100);
        taxableAmount = taxableAmount - discountAmount;
      }
      
      // Add extra bed charges if applicable - calculate based on room rates
      if (extraDetails.roomRates && Array.isArray(extraDetails.roomRates)) {
        const extraBedCharges = extraDetails.roomRates.reduce((sum, roomRate) => {
          if (!roomRate.extraBed) return sum;
          
          // Calculate extra bed days
          const startDate = new Date(roomRate.extraBedStartDate || extraDetails.checkInDate);
          const endDate = new Date(extraDetails.checkOutDate);
          
          // If start date is same or after checkout, no extra bed charge
          if (startDate >= endDate) return sum;
          
          const timeDiff = endDate.getTime() - startDate.getTime();
          const extraBedDays = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
          
          return sum + ((extraDetails.extraBedCharge || 0) * Math.max(0, extraBedDays));
        }, 0);
        
        taxableAmount += extraBedCharges;
      } else if (extraDetails.extraBed && extraDetails.extraBedCharge) {
        // Fallback for old format
        taxableAmount += extraDetails.extraBedCharge;
      }
      
      // Use custom GST rates from form data, fallback to TAX_RATES if not provided or zero
      const cgstRate = (extraDetails.cgstRate !== undefined && extraDetails.cgstRate > 0) ? extraDetails.cgstRate / 100 : TAX_RATES.cgstRate;
      const sgstRate = (extraDetails.sgstRate !== undefined && extraDetails.sgstRate > 0) ? extraDetails.sgstRate / 100 : TAX_RATES.sgstRate;
      
      const cgstAmount = taxableAmount * cgstRate;
      const sgstAmount = taxableAmount * sgstRate;
      const totalRate = taxableAmount + cgstAmount + sgstAmount; // Total with taxes

      // Process room guest details
      let roomGuestDetails = [];
      if (extraDetails.roomGuestDetails && Array.isArray(extraDetails.roomGuestDetails)) {
        roomGuestDetails = extraDetails.roomGuestDetails;
      } else {
        // Fallback: create default guest details for each room
        roomGuestDetails = bookedRoomNumbers.map(roomNum => ({
          roomNumber: roomNum,
          adults: extraDetails.noOfAdults || 1,
          children: extraDetails.noOfChildren || 0
        }));
      }

      // Process room rates from the roomRates array sent from frontend
      let roomRates = [];
      if (extraDetails.roomRates && Array.isArray(extraDetails.roomRates)) {
        roomRates = extraDetails.roomRates.map(rate => {
          // Find the actual room to get its _id
          const roomData = roomsToBook.find(r => r.room_number === rate.roomNumber);
          return {
            roomNumber: rate.roomNumber,
            roomId: roomData?._id, // Store actual room _id
            customRate: rate.customRate || 0,
            extraBed: Boolean(rate.extraBed),
            extraBedStartDate: rate.extraBedStartDate || null
          };
        });
      } else {
        // Fallback: create from room numbers and rate data
        if (bookedRoomNumbers && bookedRoomNumbers.length > 0) {
          const totalRate = extraDetails.rate || 0;
          const ratePerRoom = totalRate / bookedRoomNumbers.length;
          
          roomRates = bookedRoomNumbers.map(roomNumber => {
            const roomData = roomsToBook.find(r => r.room_number === roomNumber);
            return {
              roomNumber: roomNumber,
              roomId: roomData?._id, // Store actual room _id
              customRate: ratePerRoom,
              extraBed: roomData?.extra_bed || false,
              extraBedStartDate: null
            };
          });
        }
      }

      // Calculate total adults and children across all rooms
      const totalAdults = roomGuestDetails.reduce((sum, room) => sum + (room.adults || 1), 0);
      const totalChildren = roomGuestDetails.reduce((sum, room) => sum + (room.children || 0), 0);

      // Calculate total advance amount from multiple payments
      const advancePayments = extraDetails.advancePayments || [];
      const totalAdvanceAmount = advancePayments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      const balanceAmount = Math.max(0, totalRate - totalAdvanceAmount);

      // Create single booking document for all rooms
      const booking = new Booking({
        grcNo,
        categoryId,
        bookingDate: extraDetails.bookingDate || new Date(),
        numberOfRooms: roomsToBook.length,
        isActive: true,
        checkInDate: extraDetails.checkInDate,
        checkOutDate: extraDetails.checkOutDate,
        days: extraDetails.days,
        timeIn: extraDetails.timeIn,
        timeOut: extraDetails.timeOut,

        salutation: extraDetails.salutation,
        name: extraDetails.name,
        age: extraDetails.age,
        gender: extraDetails.gender,
        address: extraDetails.address,
        city: extraDetails.city,
        nationality: extraDetails.nationality,
        mobileNo: extraDetails.mobileNo,
        email: extraDetails.email,
        phoneNo: extraDetails.phoneNo,
        birthDate: extraDetails.birthDate,
        anniversary: extraDetails.anniversary,

        companyName: extraDetails.companyName,
        companyGSTIN: extraDetails.companyGSTIN,

        idProofType: extraDetails.idProofType,
        idProofNumber: extraDetails.idProofNumber,
        idProofImageUrl: extraDetails.idProofImageUrl,
        idProofImageUrl2: extraDetails.idProofImageUrl2,
        photoUrl: extraDetails.photoUrl,

        roomNumber: bookedRoomNumbers.join(','), // Store all room numbers as comma-separated string
        planPackage: extraDetails.planPackage,
        noOfAdults: totalAdults,
        noOfChildren: totalChildren,
        roomGuestDetails: roomGuestDetails,
        roomRates: roomRates,
        extraBed: extraDetails.extraBed || roomRates.some(room => room.extraBed === true),
        extraBedCharge: extraDetails.extraBedCharge || 0,
        extraBedRooms: extraDetails.extraBedRooms || roomRates.filter(room => room.extraBed === true).map(room => room.roomNumber),
        rate: totalRate, // Total amount including taxes
        taxableAmount: taxableAmount,
        cgstAmount: cgstAmount,
        sgstAmount: sgstAmount,
        cgstRate: cgstRate,
        sgstRate: sgstRate,
        taxIncluded: extraDetails.taxIncluded,
        serviceCharge: extraDetails.serviceCharge,

        arrivedFrom: extraDetails.arrivedFrom,
        destination: extraDetails.destination,
        remark: extraDetails.remark,
        businessSource: extraDetails.businessSource,
        marketSegment: extraDetails.marketSegment,
        purposeOfVisit: extraDetails.purposeOfVisit,

        discountPercent: extraDetails.discountPercent,
        discountRoomSource: extraDetails.discountRoomSource,
        discountNotes: extraDetails.discountNotes,

        paymentMode: extraDetails.paymentMode,
        paymentStatus: extraDetails.paymentStatus || 'Pending',

        // Multiple Advance Payments
        advancePayments: advancePayments,
        totalAdvanceAmount: totalAdvanceAmount,
        balanceAmount: balanceAmount,

        bookingRefNo: extraDetails.bookingRefNo,

        mgmtBlock: extraDetails.mgmtBlock,
        billingInstruction: extraDetails.billingInstruction,

        temperature: extraDetails.temperature,

        fromCSV: extraDetails.fromCSV,
        epabx: extraDetails.epabx,
        vip: extraDetails.vip || false,

        status: extraDetails.status || 'Booked',
        categoryId: category._id
      });

      await booking.save();

      // Fix room number based on roomRates (source of truth)
      if (roomRates && roomRates.length > 0) {
        const correctRoomNumbers = roomRates.map(rate => rate.roomNumber).filter(Boolean);
        if (correctRoomNumbers.length > 0) {
          booking.roomNumber = correctRoomNumbers.join(',');
          await booking.save();
        }
      }

      // Create audit log for booking creation
      await createAuditLog('CREATE', booking._id, req.user?.id, req.user?.role, null, booking.toObject(), req);

      // Enhanced room status update with better error logging
      for (const room of roomsToBook) {
        try {
          const updatedRoom = await Room.findOneAndUpdate(
            { 
              $or: [
                { _id: room._id },
                { room_number: room.room_number, categoryId: room.categoryId }
              ]
            },
            { status: 'booked' },
            { new: true }
          );
          
          if (updatedRoom) {
            console.log(`✅ Room ${room.room_number} (ID: ${room._id}) set to booked after booking creation`);
          } else {
            console.error(`❌ Failed to find room ${room.room_number} (ID: ${room._id}) for status update`);
          }
        } catch (error) {
          console.error(`❌ Error updating room ${room.room_number} (ID: ${room._id}) status:`, error);
        }
      }

      return [booking]; // Return array with single booking containing all rooms
    };

    // 🔹 Multiple Bookings
    if (Array.isArray(req.body.bookings)) {
      const results = [];
      for (const item of req.body.bookings) {
        const { categoryId, count, ...extraDetails } = item;
        const bookings = await handleBooking(categoryId, count, extraDetails);
        results.push(...bookings);
      }
      return res.status(201).json({ success: true, booked: results });
    }

    // 🔹 Single Booking
    const {
      categoryId,
      count,
      selectedRooms,
      ...extraDetails
    } = req.body;

    // Handle base64 image uploads to Cloudinary
    if (extraDetails.idProofImageUrl && extraDetails.idProofImageUrl.startsWith('data:')) {
      extraDetails.idProofImageUrl = await uploadBase64ToCloudinary(extraDetails.idProofImageUrl);
    }
    if (extraDetails.idProofImageUrl2 && extraDetails.idProofImageUrl2.startsWith('data:')) {
      extraDetails.idProofImageUrl2 = await uploadBase64ToCloudinary(extraDetails.idProofImageUrl2);
    }
    if (extraDetails.photoUrl && extraDetails.photoUrl.startsWith('data:')) {
      extraDetails.photoUrl = await uploadBase64ToCloudinary(extraDetails.photoUrl);
    }

    if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });

    const bookings = await handleBooking(categoryId, selectedRooms, extraDetails);

    return res.status(201).json({ success: true, booked: bookings });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// 🔹 Get all bookings with optimized single API response
exports.getBookings = async (req, res) => {
  try {
    const filter = req.query.all === 'true' ? { deleted: { $ne: true } } : { isActive: true, deleted: { $ne: true } };
    
    // Use aggregation for better performance
    const bookings = await Booking.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $limit: 500 }, // Limit results
      {
        $lookup: {
          from: 'categories',
          localField: 'categoryId',
          foreignField: '_id',
          as: 'categoryId',
          pipeline: [{ $project: { name: 1 } }]
        }
      },
      { $unwind: { path: '$categoryId', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          grcNo: 1, bookingNo: 1, invoiceNumber: 1, name: 1, mobileNo: 1, roomNumber: 1,
          checkInDate: 1, checkOutDate: 1, status: 1, rate: 1, taxableAmount: 1,
          cgstRate: 1, sgstRate: 1, cgstAmount: 1, sgstAmount: 1,
          salutation: 1, age: 1, gender: 1, address: 1, city: 1, nationality: 1,
          email: 1, phoneNo: 1, birthDate: 1, anniversary: 1,
          companyName: 1, companyGSTIN: 1, idProofType: 1, idProofNumber: 1,
          idProofImageUrl: 1, idProofImageUrl2: 1, photoUrl: 1,
          categoryId: { $ifNull: ['$categoryId', { name: 'Unknown' }] },
          createdAt: 1, days: 1, noOfAdults: 1, noOfChildren: 1,
          roomRates: 1, extraBed: 1, extraBedRooms: 1, roomGuestDetails: 1
        }
      }
    ]);
    
    // Get rooms and categories separately with minimal fields
    const [rooms, categories] = await Promise.all([
      Room.find({}, 'room_number categoryId status extra_bed').lean(),
      Category.find({}, 'name').lean()
    ]);

    res.json({ bookings, rooms, categories });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Get bookings by category

exports.getBookingsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    console.log("Received categoryId:", categoryId);

    // Convert categoryId param to ObjectId
    const mongooseCategoryId = new mongoose.Types.ObjectId(categoryId);

    // Query bookings for that categoryId
    const bookings = await Booking.find({ categoryId: mongooseCategoryId }).populate('categoryId');

    res.json(bookings);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Checkout booking (enhanced process)
exports.checkoutBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (booking.status !== 'Checked In') {
      return res.status(400).json({ error: 'Only checked-in bookings can be checked out' });
    }

    // Store original data for audit log
    const originalData = booking.toObject();

    // Update booking status to 'Checked Out'
    booking.status = 'Checked Out';
    await booking.save();

    // Create audit log for booking checkout
    await createAuditLog('CHECKOUT', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    // Handle multiple room numbers (comma-separated)
    const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
    let updatedRooms = 0;

    for (const roomNum of roomNumbers) {
      try {
        // Check for other active bookings for this room
        const otherActiveBookings = await Booking.countDocuments({
          _id: { $ne: bookingId },
          roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNum}\\s*(,|$)`) },
          status: { $in: ['Booked', 'Checked In'] },
          isActive: true
        });

        const newStatus = otherActiveBookings > 0 ? 'booked' : 'available';

        // Enhanced room lookup - try multiple approaches
        let updatedRoom = await Room.findOneAndUpdate(
          { room_number: roomNum },
          { status: newStatus },
          { new: true }
        );
        
        // If not found by room_number, try with categoryId from booking
        if (!updatedRoom && booking.categoryId) {
          updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum, categoryId: booking.categoryId },
            { status: newStatus },
            { new: true }
          );
        }
        
        // If still not found, try by roomId from roomRates
        if (!updatedRoom && booking.roomRates) {
          const roomRate = booking.roomRates.find(r => r.roomNumber === roomNum);
          if (roomRate && roomRate.roomId) {
            updatedRoom = await Room.findOneAndUpdate(
              { _id: roomRate.roomId },
              { status: newStatus },
              { new: true }
            );
          }
        }

        if (updatedRoom) {
          updatedRooms++;
          console.log(`✅ Room ${roomNum} (ID: ${updatedRoom._id}) set to ${newStatus} after checkout (${otherActiveBookings} other active bookings)`);
        } else {
          console.error(`❌ Could not find room ${roomNum} to update status - tried room_number, categoryId, and roomId lookup`);
        }
      } catch (error) {
        console.error(`❌ Error updating room ${roomNum} status:`, error);
      }
    }

    res.json({
      success: true,
      message: `Checkout completed. ${updatedRooms} room(s) are now available.`,
      booking,
      roomsUpdated: updatedRooms,
      totalRooms: roomNumbers.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Unbook (soft delete)
exports.deleteBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Store original data for audit log
    const originalData = booking.toObject();

    // Even if booking is already inactive, proceed with room status update
    if (!booking.isActive) {
      console.log('Note: Booking was already inactive, proceeding with room status update');
    } else {
      booking.isActive = false;
      await booking.save();
    }

    // Create audit log for booking deletion
    await createAuditLog('CANCEL', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    // Handle multiple room numbers (comma-separated)
    const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
    let updatedRooms = 0;

    for (const roomNum of roomNumbers) {
      try {
        // Check for other active bookings for this room
        const otherActiveBookings = await Booking.countDocuments({
          _id: { $ne: bookingId },
          roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNum}\\s*(,|$)`) },
          status: { $in: ['Booked', 'Checked In'] },
          isActive: true
        });

        const newStatus = otherActiveBookings > 0 ? 'booked' : 'available';

        // Enhanced room lookup - try multiple approaches
        let updatedRoom = await Room.findOneAndUpdate(
          { room_number: roomNum },
          { status: newStatus },
          { new: true }
        );
        
        // If not found by room_number, try with categoryId from booking
        if (!updatedRoom && booking.categoryId) {
          updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum, categoryId: booking.categoryId },
            { status: newStatus },
            { new: true }
          );
        }
        
        // If still not found, try by roomId from roomRates
        if (!updatedRoom && booking.roomRates) {
          const roomRate = booking.roomRates.find(r => r.roomNumber === roomNum);
          if (roomRate && roomRate.roomId) {
            updatedRoom = await Room.findOneAndUpdate(
              { _id: roomRate.roomId },
              { status: newStatus },
              { new: true }
            );
          }
        }

        if (updatedRoom) {
          updatedRooms++;
          console.log(`✅ Room ${roomNum} (ID: ${updatedRoom._id}) set to ${newStatus} after cancellation (${otherActiveBookings} other active bookings)`);
        } else {
          console.error(`❌ Could not find room ${roomNum} to update status - tried room_number, categoryId, and roomId lookup`);
        }
      } catch (error) {
        console.error(`❌ Error updating room ${roomNum} status:`, error);
      }
    }

    res.json({
      success: true,
      message: `Booking cancelled. ${updatedRooms} room(s) are now available.`,
      roomsUpdated: updatedRooms,
      totalRooms: roomNumbers.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 SOFT DELETE
exports.permanentlyDeleteBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Store original data for audit log
    const originalData = booking.toObject();

    booking.deleted = true;
    booking.deletedAt = new Date();
    booking.deletedBy = req.user?.username || 'System';
    await booking.save();

    // Create audit log for permanent booking deletion
    await createAuditLog('DELETE', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    res.json({ success: true, message: 'Booking deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Update booking
exports.updateBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const updates = req.body;

    // Fields that cannot be updated directly
    const restrictedFields = ['isActive', 'bookingRefNo', 'createdAt', '_id', 'grcNo'];
    restrictedFields.forEach(field => delete updates[field]);

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Store original data for audit log
    const originalData = booking.toObject();

    // Handle status change to Checked In - validate room availability and set actual check-in time
    if (updates.status && updates.status === 'Checked In') {
      const roomNumbers = booking.roomNumber ? booking.roomNumber.split(',').map(num => num.trim()) : [];
      
      // Check if any of the rooms have an active booking that's already checked in
      for (const roomNum of roomNumbers) {
        const activeBooking = await Booking.findOne({
          _id: { $ne: bookingId }, // Exclude current booking
          roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNum}\\s*(,|$)`) },
          status: 'Checked In',
          isActive: true
        });
        
        if (activeBooking) {
          return res.status(400).json({ 
            error: `Cannot check in: Room ${roomNum} is currently occupied by another guest (GRC: ${activeBooking.grcNo}, Invoice: ${activeBooking.invoiceNumber || 'N/A'}). Please check out the current guest first.`
          });
        }
      }
      
      // Set actual check-in time
      booking.actualCheckInTime = new Date();
      
      // Set room status to booked when checking in
      for (const roomNum of roomNumbers) {
        try {
          const updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum },
            { status: 'booked' },
            { new: true }
          );
          
          if (updatedRoom) {
            console.log(`Room ${roomNum} set to booked after check-in`);
          } else {
            console.log(`Warning: Could not find room ${roomNum} to update status`);
          }
        } catch (error) {
          console.error(`Error updating room ${roomNum} status on check-in:`, error);
        }
      }
    }
    
    // Handle status change to Checked Out - set actual check-out time
    if (updates.status && updates.status === 'Checked Out') {
      booking.actualCheckOutTime = new Date();
    }

    // Handle status change to Cancelled or Checked Out
    if (updates.status && (updates.status === 'Cancelled' || updates.status === 'Checked Out')) {
      const roomNumbers = booking.roomNumber ? booking.roomNumber.split(',').map(num => num.trim()) : [];
      
      // Check for other active bookings before setting rooms to available
      for (const roomNum of roomNumbers) {
        try {
          // Check for other active bookings for this room
          const otherActiveBookings = await Booking.countDocuments({
            _id: { $ne: bookingId },
            roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNum}\\s*(,|$)`) },
            status: { $in: ['Booked', 'Checked In'] },
            isActive: true
          });

          const newStatus = otherActiveBookings > 0 ? 'booked' : 'available';

          // Update room status
          const updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum },
            { status: newStatus },
            { new: true }
          );

          if (updatedRoom) {
            console.log(`Room ${roomNum} set to ${newStatus} after ${updates.status} (${otherActiveBookings} other active bookings)`);
          } else {
            console.log(`Warning: Could not find room ${roomNum} to update status`);
          }
        } catch (error) {
          console.error(`Error updating room ${roomNum} status:`, error);
        }
      }
    }

    // Handle room changes if selectedRooms is provided
    if (updates.selectedRooms && Array.isArray(updates.selectedRooms)) {
      const oldRoomNumbers = booking.roomNumber ? booking.roomNumber.split(',').map(num => num.trim()) : [];
      const newRoomNumbers = updates.selectedRooms.map(room => room.room_number);
      
      // Set old rooms to available (check for other bookings first)
      for (const roomNum of oldRoomNumbers) {
        try {
          // Check for other active bookings for this room
          const otherActiveBookings = await Booking.countDocuments({
            _id: { $ne: bookingId },
            roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNum}\\s*(,|$)`) },
            status: { $in: ['Booked', 'Checked In'] },
            isActive: true
          });

          const newStatus = otherActiveBookings > 0 ? 'booked' : 'available';

          // Update room status
          const updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum },
            { status: newStatus },
            { new: true }
          );

          if (updatedRoom) {
            console.log(`Room ${roomNum} set to ${newStatus} after room change (${otherActiveBookings} other active bookings)`);
          } else {
            console.log(`Warning: Could not find room ${roomNum} to update status`);
          }
        } catch (error) {
          console.error(`Error updating room ${roomNum} status:`, error);
        }
      }
      
      // Set new rooms to booked
      for (const roomNum of newRoomNumbers) {
        try {
          const updatedRoom = await Room.findOneAndUpdate(
            { room_number: roomNum },
            { status: 'booked' },
            { new: true }
          );
          
          if (updatedRoom) {
            console.log(`Room ${roomNum} set to booked after room change`);
          } else {
            console.log(`Warning: Could not find room ${roomNum} to update status`);
          }
        } catch (error) {
          console.error(`Error updating room ${roomNum} status:`, error);
        }
      }
      
      // Update booking with new room numbers
      booking.roomNumber = newRoomNumbers.join(',');
      booking.numberOfRooms = newRoomNumbers.length;
      
      // Remove selectedRooms from updates to avoid saving it to booking
      delete updates.selectedRooms;
    }

    // Update allowed simple fields directly on booking document
    const simpleFields = [
      'salutation', 'name', 'age', 'gender', 'address', 'city', 'nationality',
      'mobileNo', 'email', 'phoneNo', 'birthDate', 'anniversary',

      'companyName', 'companyGSTIN',

      'idProofType', 'idProofNumber', 'idProofImageUrl', 'idProofImageUrl2', 'photoUrl',

      'roomNumber', 'planPackage', 'noOfAdults', 'noOfChildren', 'roomGuestDetails', 'extraBedCharge', 'rate', 'taxableAmount', 'cgstAmount', 'sgstAmount', 'cgstRate', 'sgstRate', 'taxIncluded', 'serviceCharge',

      'arrivedFrom', 'destination', 'remark', 'businessSource', 'marketSegment', 'purposeOfVisit',

      'discountPercent', 'discountRoomSource', 'discountNotes',

      'paymentMode', 'paymentStatus',

      'bookingRefNo', 'mgmtBlock', 'billingInstruction',

      'temperature', 'fromCSV', 'epabx', 'vip',

      'status', 'categoryId',

      'bookingDate', 'numberOfRooms', 'checkInDate', 'checkOutDate', 'days', 'timeIn', 'timeOut',

      // Invoice number
      'invoiceNumber',

      // Multiple Advance Payment fields
      'advancePayments', 'totalAdvanceAmount', 'balanceAmount',
      
      // Exact check-in/check-out times
      'actualCheckInTime', 'actualCheckOutTime'
    ];

    simpleFields.forEach(field => {
      if (typeof updates[field] !== 'undefined') {
        // Skip empty categoryId to prevent validation errors
        if (field === 'categoryId' && (!updates[field] || updates[field] === '')) {
          return;
        }
        // Handle GST rates conversion from percentage to decimal
        if (field === 'cgstRate' || field === 'sgstRate') {
          booking[field] = updates[field] / 100;
        } else {
          booking[field] = updates[field];
        }
      }
    });

    // Handle roomRates and extraBed separately
    if (updates.roomRates && Array.isArray(updates.roomRates)) {
      booking.roomRates = updates.roomRates;
      // Set booking level extraBed based on room-specific data
      booking.extraBed = updates.roomRates.some(room => room.extraBed === true);
      // Update extraBedRooms array
      booking.extraBedRooms = updates.roomRates.filter(room => room.extraBed === true).map(room => room.roomNumber);
    }

    // Extension History (for updates related to extension)
    if (updates.extendedCheckOut) {
      const originalCheckIn = booking.checkInDate;
      const originalCheckOut = booking.checkOutDate;

      booking.extensionHistory.push({
        originalCheckIn,
        originalCheckOut,
        extendedCheckOut: new Date(updates.extendedCheckOut),
        reason: updates.reason,
        additionalAmount: updates.additionalAmount,
        paymentMode: updates.paymentMode,
        approvedBy: updates.approvedBy
      });

      booking.checkOutDate = new Date(updates.extendedCheckOut);

      if (updates.additionalAmount) {
        booking.rate = (booking.rate || 0) + updates.additionalAmount;
      }
    }

    await booking.save({ validateBeforeSave: false });

    // Create audit log for booking update
    await createAuditLog('UPDATE', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    res.json({
      success: true,
      message: 'Booking updated successfully',
      booking
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Extend booking stay
exports.extendBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { extendedCheckOut, reason, additionalAmount, paymentMode, approvedBy } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if (!booking.isActive) {
      return res.status(400).json({ error: 'Cannot extend inactive booking' });
    }

    // Store original data for audit log
    const originalData = booking.toObject();
    const originalCheckIn = booking.checkInDate;
    const originalCheckOut = booking.checkOutDate;

    // Add to extension history
    booking.extensionHistory.push({
      originalCheckIn,
      originalCheckOut,
      extendedCheckOut: new Date(extendedCheckOut),
      reason,
      additionalAmount,
      paymentMode,
      approvedBy
    });

    // Update checkout date
    booking.checkOutDate = new Date(extendedCheckOut);

    // Update rate if additionalAmount provided
    if (additionalAmount) {
      booking.rate = (booking.rate || 0) + additionalAmount;
    }

    await booking.save();

    // Create audit log for booking extension
    await createAuditLog('EXTEND', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    res.json({
      success: true,
      message: 'Booking extended successfully',
      booking
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get booking by GRC Number
exports.getBookingByGRC = async (req, res) => {
  try {
    const { grcNo } = req.params;
    const booking = await Booking.findOne({ grcNo }, {
      name: 1, grcNo: 1, roomNumber: 1, checkInDate: 1, checkOutDate: 1,
      status: 1, rate: 1, categoryId: 1, mobileNo: 1, days: 1
    }).populate('categoryId', 'name').lean();

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found with given GRC' });
    }

    if (!booking.categoryId) booking.categoryId = { name: 'Unknown' };
    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getDetailsByGrc = async (req, res) => {
  try {
    const { grcNo } = req.params;

    const record = await Booking.findOne({ grcNo });

    if (!record) {
      return res.status(404).json({ message: "No booking found for this GRC" });
    }

    res.json(record);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Get customer details by GRC for returning customers (new booking)
exports.getCustomerDetailsByGRC = async (req, res) => {
  try {
    const { grcNo } = req.params;

    const booking = await Booking.findOne({ grcNo }).populate('categoryId');

    if (!booking) {
      return res.status(404).json({ error: 'No customer found with given GRC' });
    }

    // Extract only customer-related fields, not booking-specific data
    const customerDetails = {
      // Customer personal details
      salutation: booking.salutation,
      name: booking.name,
      age: booking.age,
      gender: booking.gender,
      address: booking.address,
      city: booking.city,
      nationality: booking.nationality,
      mobileNo: booking.mobileNo,
      email: booking.email,
      phoneNo: booking.phoneNo,
      birthDate: booking.birthDate,
      anniversary: booking.anniversary,
      
      // Company details
      companyName: booking.companyName,
      companyGSTIN: booking.companyGSTIN,
      
      // ID proof details
      idProofType: booking.idProofType,
      idProofNumber: booking.idProofNumber,
      idProofImageUrl: booking.idProofImageUrl,
      idProofImageUrl2: booking.idProofImageUrl2,
      
      // Photo and preferences
      photoUrl: booking.photoUrl,
      vip: booking.vip,
      
      // Original GRC for reference
      originalGRC: booking.grcNo
    };

    res.json({ 
      success: true, 
      customerDetails,
      message: `Customer details found for GRC ${grcNo}` 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Search customers by name or mobile for quick lookup
exports.searchCustomers = async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const searchRegex = new RegExp(query.trim(), 'i');
    
    const customers = await Booking.find({
      $or: [
        { name: searchRegex },
        { mobileNo: searchRegex },
        { email: searchRegex },
        { grcNo: searchRegex }
      ]
    }, 'grcNo name mobileNo email createdAt').sort({ createdAt: -1 }).limit(10).lean();

    res.json({ success: true, customers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Get booking by Booking Number
exports.getBookingByNumber = async (req, res) => {
  try {
    const { bookingNo } = req.params;
    const booking = await Booking.findOne({ bookingNo }, {
      name: 1, grcNo: 1, roomNumber: 1, checkInDate: 1, checkOutDate: 1,
      status: 1, rate: 1, categoryId: 1, mobileNo: 1, days: 1
    }).populate('categoryId', 'name').lean();

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!booking.categoryId) booking.categoryId = { name: 'Unknown' };
    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get complete booking details by ID (for editing)
exports.getCompleteBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId).populate('categoryId');

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get booking by Booking ID
exports.getBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId, {
      name: 1, grcNo: 1, roomNumber: 1, checkInDate: 1, checkOutDate: 1,
      status: 1, rate: 1, categoryId: 1, mobileNo: 1, days: 1
    }).populate('categoryId', 'name').lean();

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!booking.categoryId) booking.categoryId = { name: 'Unknown' };
    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get comprehensive booking details with all charges in one API call
exports.getBookingDetailsWithCharges = async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    // Get booking details
    const booking = await Booking.findOne({ bookingNo: bookingId }).populate('categoryId');
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Get all charges in parallel
    const [roomServiceOrders, restaurantOrders, laundryOrders] = await Promise.all([
      require('../models/RoomService').find({
        bookingId: booking._id,
        status: { $nin: ['cancelled', 'canceled'] }
      }),
      require('../models/RestaurantOrder').find({
        $or: [
          { bookingId: booking._id },
          { bookingNumber: booking.grcNo }
        ],
        status: { $nin: ['cancelled', 'canceled'] }
      }),
      require('../models/Laundry').find({
        $or: [
          { bookingId: booking._id },
          { grcNo: booking.grcNo },
          { roomNumber: { $in: booking.roomNumber ? booking.roomNumber.split(',').map(num => num.trim()) : [] } }
        ],
        laundryStatus: { $nin: ['cancelled', 'canceled'] }
      })
    ]);

    // Return comprehensive data
    res.json({
      success: true,
      booking,
      serviceCharges: roomServiceOrders,
      restaurantCharges: restaurantOrders,
      laundryCharges: laundryOrders
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get booking history with invoices
exports.getBookingHistory = async (req, res) => {
  try {
    const Invoice = require('../models/Invoice');
    
    const bookings = await Booking.find({
      status: { $in: ['Booked', 'Checked In', 'Checked Out'] }
    }).populate('categoryId').sort({ createdAt: -1 });

    const bookingHistory = await Promise.all(
      bookings.map(async (booking) => {
        const invoices = await Invoice.find({ bookingId: booking._id });
        return {
          ...(booking.toObject ? booking.toObject() : booking),
          invoices
        };
      })
    );

    res.json({ success: true, bookings: bookingHistory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Amend booking stay dates
exports.amendBookingStay = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { newCheckOutDate, reason } = req.body;

    if (!newCheckOutDate) {
      return res.status(400).json({ error: 'New check-out date is required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (!booking.isActive) {
      return res.status(400).json({ error: 'Cannot amend inactive booking' });
    }

    // Store original data for audit log
    const originalData = booking.toObject();

    if (booking.status === 'Checked Out') {
      return res.status(400).json({ error: 'Cannot amend checked out booking' });
    }

    // Check amendment limits
    const amendmentCount = booking.amendmentHistory?.length || 0;
    if (amendmentCount >= 3) {
      return res.status(400).json({ error: 'Maximum 3 amendments allowed per booking' });
    }

    // Check if amendment is within allowed timeframe (24 hours before checkout)
    const currentTime = new Date();
    const originalCheckOut = new Date(booking.checkOutDate);
    const timeDiffHours = (originalCheckOut - currentTime) / (1000 * 60 * 60);
    
    if (timeDiffHours < 24) {
      return res.status(400).json({ error: 'Cannot amend booking within 24 hours of checkout' });
    }

    // Check if the same rooms are available for the new dates
    const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
    const originalCheckIn = booking.checkInDate; // Keep original check-in date
    const newCheckOut = new Date(newCheckOutDate);
    
    // Calculate new days
    const timeDiff = newCheckOut.getTime() - originalCheckIn.getTime();
    const newDays = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

    if (newDays <= 0) {
      return res.status(400).json({ error: 'Check-out date must be after original check-in date' });
    }

    // Check room availability for new dates (excluding current booking)
    for (const roomNumber of roomNumbers) {
      const conflictingBookings = await Booking.find({
        _id: { $ne: bookingId }, // Exclude current booking
        roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNumber}\\s*(,|$)`) },
        status: { $in: ['Booked', 'Checked In'] },
        isActive: true,
        $or: [
          {
            checkInDate: { $lt: newCheckOut },
            checkOutDate: { $gt: originalCheckIn }
          }
        ]
      });

      if (conflictingBookings.length > 0) {
        return res.status(400).json({ 
          error: `Room ${roomNumber} is not available for the extended dates`,
          conflictingBookings: conflictingBookings.map(b => ({
            grcNo: b.grcNo,
            checkIn: b.checkInDate,
            checkOut: b.checkOutDate
          }))
        });
      }
    }

    // Store original dates for history
    const originalCheckOutDate = booking.checkOutDate;
    const originalDays = booking.days;

    // Calculate rate adjustment
    let rateAdjustment = 0;
    if (booking.roomRates && Array.isArray(booking.roomRates)) {
      const dailyRate = booking.roomRates.reduce((sum, room) => sum + (room.customRate || 0), 0);
      rateAdjustment = dailyRate * (newDays - originalDays);
    }

    // Calculate extra bed adjustment
    let extraBedAdjustment = 0;
    if (booking.roomRates && Array.isArray(booking.roomRates)) {
      extraBedAdjustment = booking.roomRates.reduce((sum, room) => {
        if (!room.extraBed) return sum;
        const extraBedDays = newDays;
        const originalExtraBedDays = originalDays;
        return sum + ((booking.extraBedCharge || 0) * (extraBedDays - originalExtraBedDays));
      }, 0);
    }

    // Calculate amendment fee (₹500 for each amendment after first)
    const amendmentFee = amendmentCount > 0 ? 500 : 0;
    
    const totalAdjustment = rateAdjustment + extraBedAdjustment + amendmentFee;
    const newTaxableAmount = (booking.taxableAmount || 0) + totalAdjustment;
    const newCgstAmount = newTaxableAmount * (booking.cgstRate || 0.025);
    const newSgstAmount = newTaxableAmount * (booking.sgstRate || 0.025);
    const newTotalAmount = newTaxableAmount + newCgstAmount + newSgstAmount;

    // Add amendment to history
    if (!booking.amendmentHistory) {
      booking.amendmentHistory = [];
    }
    
    booking.amendmentHistory.push({
      originalCheckIn,
      originalCheckOut: originalCheckOutDate,
      originalDays,
      newCheckIn: originalCheckIn, // Keep same check-in date
      newCheckOut: newCheckOut,
      newDays,
      amendedOn: new Date(),
      reason: reason || 'Customer requested checkout date change',
      rateAdjustment,
      extraBedAdjustment,
      totalAdjustment,
      amendmentFee,
      status: 'Approved',
      approvedBy: 'System',
      approvedOn: new Date()
    });

    // Update booking with new checkout date only
    booking.checkOutDate = newCheckOut;
    booking.days = newDays;
    booking.taxableAmount = newTaxableAmount;
    booking.cgstAmount = newCgstAmount;
    booking.sgstAmount = newSgstAmount;
    booking.rate = newTotalAmount;

    await booking.save();

    // Create audit log for booking amendment
    await createAuditLog('AMEND', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);

    // Send notification (implement your notification service)
    try {
      console.log(`Amendment notification sent for booking ${booking.grcNo}`);
    } catch (notificationError) {
      console.error('Failed to send amendment notification:', notificationError);
    }

    res.json({
      success: true,
      message: 'Booking stay amended successfully',
      booking,
      amendment: {
        originalDates: { checkIn: originalCheckIn, checkOut: originalCheckOutDate, days: originalDays },
        newDates: { checkIn: originalCheckIn, checkOut: newCheckOut, days: newDays },
        rateAdjustment,
        extraBedAdjustment,
        totalAdjustment,
        newTotalAmount
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get conflicting bookings for amendment
exports.getConflictingBookings = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
    const conflictingDates = [];

    for (const roomNumber of roomNumbers) {
      const conflictingBookings = await Booking.find({
        _id: { $ne: bookingId },
        roomNumber: { $regex: new RegExp(`(^|,)\\s*${roomNumber}\\s*(,|$)`) },
        status: { $in: ['Booked', 'Checked In'] },
        isActive: true
      }).select('checkInDate checkOutDate grcNo');

      conflictingBookings.forEach(cb => {
        const checkIn = new Date(cb.checkInDate);
        const checkOut = new Date(cb.checkOutDate);
        
        for (let d = new Date(checkIn); d < checkOut; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          if (!conflictingDates.includes(dateStr)) {
            conflictingDates.push(dateStr);
          }
        }
      });
    }

    res.json({ conflictingDates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get all charges and services for a booking
exports.getBookingCharges = async (req, res) => {
  try {
    const { bookingId, grcNo } = req.params;
    const RoomService = require('../models/RoomService');
    const RestaurantOrder = require('../models/RestaurantOrder');
    const Laundry = require('../models/Laundry');
    
    let booking;
    let serviceQuery = {};
    let restaurantQuery = {};
    let laundryQuery = {};
    
    if (bookingId) {
      booking = await Booking.findById(bookingId).populate('categoryId');
      serviceQuery.bookingId = bookingId;
      restaurantQuery.bookingId = bookingId;
      laundryQuery.bookingId = bookingId;
    } else if (grcNo) {
      booking = await Booking.findOne({ grcNo }).populate('categoryId');
      serviceQuery.grcNo = grcNo;
      restaurantQuery.grcNo = grcNo;
      laundryQuery.grcNo = grcNo;
    } else {
      return res.status(400).json({ error: 'Either bookingId or grcNo is required' });
    }
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Get all room services for this booking (exclude cancelled and non-chargeable)
    const roomServices = await RoomService.find({
      ...serviceQuery,
      paymentStatus: { $ne: 'paid' },
      status: { $nin: ['cancelled', 'canceled'] },
      nonChargeable: { $ne: true }
    }).sort({ createdAt: -1 });
    
    // Get all restaurant orders for this booking
    // Try multiple query approaches since restaurant orders might not have grcNo/bookingId populated
    const restaurantOrderQueries = [restaurantQuery];
    
    // Also search by room number if available
    if (booking.roomNumber) {
      const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
      restaurantOrderQueries.push({ tableNo: { $in: roomNumbers } });
    }
    
    const restaurantOrders = await RestaurantOrder.find({
      $or: restaurantOrderQueries,
      paymentStatus: { $ne: 'paid' },
      status: { $nin: ['cancelled', 'canceled'] },
      nonChargeable: { $ne: true }
    }).sort({ createdAt: -1 });
    
    // Get all laundry orders for this booking
    const laundryOrderQueries = [laundryQuery];
    
    // Also search by room number if available
    if (booking.roomNumber) {
      const roomNumbers = booking.roomNumber.split(',').map(num => num.trim());
      laundryOrderQueries.push({ roomNumber: { $in: roomNumbers } });
    }
    
    const laundryOrders = await Laundry.find({
      $or: laundryOrderQueries,
      laundryStatus: { $nin: ['cancelled', 'canceled'] }
    }).sort({ createdAt: -1 });
    
    // Calculate totals excluding non-chargeable items
    const totalServiceCharges = roomServices.reduce((sum, service) => sum + (service.totalAmount || 0), 0);
    const totalRestaurantCharges = restaurantOrders.reduce((sum, order) => sum + (order.amount || 0), 0);
    const totalLaundryCharges = laundryOrders.reduce((sum, order) => {
      const chargeableAmount = order.items.filter(item => !item.nonChargeable && item.status !== 'lost').reduce((itemSum, item) => itemSum + (item.calculatedAmount || 0), 0);
      return sum + chargeableAmount;
    }, 0);
    
    // Prepare response with booking details and all charges
    const charges = {
      booking: {
        grcNo: booking.grcNo,
        roomNumber: booking.roomNumber,
        guestName: booking.name,
        checkIn: booking.checkInDate,
        checkOut: booking.checkOutDate,
        days: booking.days,
        categoryName: booking.categoryId?.name || 'Unknown'
      },
      roomCharges: {
        taxableAmount: booking.taxableAmount || 0,
        cgstAmount: booking.cgstAmount || 0,
        sgstAmount: booking.sgstAmount || 0,
        extraBedCharge: booking.extraBedCharge || 0,
        totalRoomCharges: booking.rate || 0
      },
      services: roomServices.map(service => ({
        type: 'service',
        orderNumber: service.orderNumber,
        serviceType: service.serviceType,
        items: service.items,
        subtotal: service.subtotal,
        tax: service.tax,
        serviceCharge: service.serviceCharge,
        totalAmount: service.totalAmount,
        status: service.status,
        paymentStatus: service.paymentStatus,
        createdAt: service.createdAt
      })),
      restaurantOrders: restaurantOrders.map(order => ({
        type: 'restaurant',
        orderId: order._id,
        tableNo: order.tableNo,
        items: order.items,
        subtotal: order.subtotal,
        sgstAmount: order.sgstAmount,
        cgstAmount: order.cgstAmount,
        totalGstAmount: order.totalGstAmount,
        amount: order.amount,
        discount: order.discount,
        status: order.status,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt
      })),
      laundryOrders: laundryOrders.map(order => ({
        type: 'laundry',
        orderId: order._id,
        orderType: order.orderType,
        roomNumber: order.roomNumber,
        serviceType: order.serviceType,
        items: order.items,
        totalAmount: order.totalAmount,
        laundryStatus: order.laundryStatus,
        createdAt: order.createdAt
      })),
      summary: {
        totalRoomCharges: booking.rate || 0,
        totalServiceCharges,
        totalRestaurantCharges,
        totalLaundryCharges,
        subtotal: (booking.taxableAmount || 0) + totalServiceCharges + totalRestaurantCharges + totalLaundryCharges,
        cgstAmount: Math.round(((booking.taxableAmount || 0) + totalServiceCharges + totalRestaurantCharges + totalLaundryCharges) * (booking.cgstRate || 0.025) * 100) / 100,
        sgstAmount: Math.round(((booking.taxableAmount || 0) + totalServiceCharges + totalRestaurantCharges + totalLaundryCharges) * (booking.sgstRate || 0.025) * 100) / 100,
        totalTax: Math.round(((booking.taxableAmount || 0) + totalServiceCharges + totalRestaurantCharges + totalLaundryCharges) * ((booking.cgstRate || 0.025) + (booking.sgstRate || 0.025)) * 100) / 100,
        grandTotal: Math.round(((booking.taxableAmount || 0) + totalServiceCharges + totalRestaurantCharges + totalLaundryCharges) * (1 + (booking.cgstRate || 0.025) + (booking.sgstRate || 0.025)) * 100) / 100
      }
    };
    
    res.json({ success: true, charges });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get next GRC number for new booking
exports.getNextGRC = async (req, res) => {
  try {
    const grcNo = await generateGRC();
    res.json({ success: true, grcNo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 🔹 Waive late checkout fine
exports.waiveLateCheckoutFine = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { reason, waivedBy } = req.body;
    
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    
    if (!booking.lateCheckoutFine.applied) {
      return res.status(400).json({ error: 'No late checkout fine to waive' });
    }
    
    if (booking.lateCheckoutFine.waived) {
      return res.status(400).json({ error: 'Late checkout fine already waived' });
    }
    
    // Store original data for audit log
    const originalData = booking.toObject();
    
    // Waive the fine
    booking.lateCheckoutFine.waived = true;
    booking.lateCheckoutFine.waivedBy = waivedBy || req.user?.username || 'System';
    booking.lateCheckoutFine.waivedReason = reason || 'Management discretion';
    
    await booking.save();
    
    // Create audit log
    await createAuditLog('WAIVE_FINE', booking._id, req.user?.id, req.user?.role, originalData, booking.toObject(), req);
    
    res.json({
      success: true,
      message: `Late checkout fine of ₹${booking.lateCheckoutFine.amount} waived successfully`,
      booking
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Fix room availability - utility function to sync room status with booking status
exports.fixRoomAvailability = async (req, res) => {
  try {
    // Find all rooms that are marked as 'booked'
    const bookedRooms = await Room.find({ status: 'booked' });
    
    let fixedCount = 0;
    
    for (const room of bookedRooms) {
      // Check if there's an active booking for this room (handle comma-separated room numbers)
      const activeBooking = await Booking.findOne({
        $or: [
          { roomNumber: room.room_number },
          { roomNumber: { $regex: new RegExp(`(^|,)\\s*${room.room_number}\\s*(,|$)`) } }
        ],
        status: { $in: ['Booked', 'Checked In'] },
        isActive: true
      });
      
      // If no active booking found, make room available
      if (!activeBooking) {
        room.status = 'available';
        await room.save();
        fixedCount++;
        console.log(`Fixed room ${room.room_number} - set to available`);
      }
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} rooms that were incorrectly marked as booked`,
      fixedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Fix booking room numbers based on roomRates data
exports.fixBookingRoomNumbers = async (req, res) => {
  try {
    const bookings = await Booking.find({ 
      deleted: { $ne: true },
      roomRates: { $exists: true, $ne: [] }
    });
    
    let fixedCount = 0;
    
    for (const booking of bookings) {
      // Get room numbers from roomRates array (most reliable source)
      const roomNumbersFromRates = booking.roomRates.map(rate => rate.roomNumber).filter(Boolean);
      
      if (roomNumbersFromRates.length > 0) {
        const correctRoomNumber = roomNumbersFromRates.join(',');
        
        // Only update if different
        if (booking.roomNumber !== correctRoomNumber) {
          console.log(`Fixing booking ${booking.grcNo}: ${booking.roomNumber} -> ${correctRoomNumber}`);
          
          booking.roomNumber = correctRoomNumber;
          await booking.save();
          fixedCount++;
        }
      }
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} booking room numbers`,
      fixedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
