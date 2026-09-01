const mongoose = require("mongoose");
const crypto = require("crypto");
const Order = require("../models/order.model");
const Cart = require("../models/cart.model");
const Product = require("../models/product.model");
const Discount = require("../models/discount.model");
const Address = require("../models/address.model");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const { sendOrderConfirmationEmail: sendOrderConfirmationEmailService } = require("../services/email.service");
const notificationEventEmitter = require("../services/notificationEventEmitter");

const ESEWA_CONFIG = {
  merchantId: process.env.ESEWA_MERCHANT_ID || "EPAYTEST",
  secretKey: process.env.ESEWA_SECRET_KEY || "8gBm/:&EnhH.1/q",
  paymentUrl:
    process.env.NODE_ENV === "production"
      ? "https://epay.esewa.com.np/api/epay/main/v2/form"
      : "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
  statusUrl:
    process.env.NODE_ENV === "production"
      ? "https://esewa.com.np/api/epay/transaction/status/"
      : "https://rc.esewa.com.np/api/epay/transaction/status/",
};

const FRONTEND_URL = process.env.FRONTEND_URL || "https://localhost:5173";

// Generate HMAC-SHA256 signature for eSewa ePay v2
const generateEsewaSignature = (message) => {
  const hmac = crypto.createHmac("sha256", ESEWA_CONFIG.secretKey);
  hmac.update(message);
  return hmac.digest("base64");
};

// Verify eSewa response signature
const verifyEsewaSignature = (responseData) => {
  const fields = responseData.signed_field_names.split(",");
  const message = fields.map((f) => `${f}=${responseData[f]}`).join(",");
  const expectedSignature = generateEsewaSignature(message);
  return expectedSignature === responseData.signature;
};

// Helper function to validate and prepare cart items
const prepareOrderItems = async (items, session = null) => {
  const orderItems = [];

  // FIX: Batch fetch all products instead of one query per item (N+1 prevention)
  // Extract all product IDs first
  const productIds = items.map((item) => item.productId || item.product);

  // Single batch query for all products
  const products = await Product.find({
    _id: { $in: productIds },
  }).session(session);

  // Create a map for O(1) lookup
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  // Validate and prepare items
  for (const item of items) {
    const productId = item.productId || item.product;
    const product = productMap.get(productId.toString());

    if (!product) {
      throw new AppError(`Product not found: ${productId}`, 404);
    }
    if (product.stock < item.quantity) {
      throw new AppError(`Insufficient stock for ${product.name}`, 400);
    }

    // Get primary image
    const primaryImage =
      product.images?.find((img) => img.isPrimary)?.url ||
      product.images?.[0]?.url ||
      null;

    orderItems.push({
      product: product._id,
      name: product.name,
      price: product.price,
      quantity: item.quantity,
      variant: item.variant || {},
      image: primaryImage,
    });
  }

  return orderItems;
};

// Helper to calculate order totals
const calculateOrderTotals = async (items, discountCode, session = null) => {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.quantity;
  }

  let discountAmount = 0;
  let discountInfo = null;

  if (discountCode) {
    const discount = await Discount.findOne({
      code: discountCode.toUpperCase(),
      isActive: true,
      expiryDate: { $gt: new Date() },
    }).session(session);

    if (discount) {
      const validation = discount.validateForCart(subtotal);
      if (validation.valid) {
        discountAmount = discount.calculateDiscount(subtotal);
        discountInfo = {
          code: discount.code,
          percentage: discount.discountPercentage,
        };
      }
    }
  }

  const shippingCost = 0; // Free shipping
  const tax = 0;
  const total = subtotal - discountAmount + shippingCost + tax;

  return { subtotal, discountAmount, discountInfo, shippingCost, tax, total };
};

// Backend URL for eSewa callbacks
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8080";

// Helper function to send order confirmation email
const sendOrderConfirmationEmail = async (order) => {
  try {
    await sendOrderConfirmationEmailService(order);
    return true;
  } catch (error) {
    console.error("Failed to send order confirmation email:", error.message);
    return false;
  }
};

// Generate eSewa ePay v2 payment data with signature
const generateEsewaPaymentData = (order) => {
  const data = {
    amount: (order.subtotal - order.discountAmount).toFixed(2),
    tax_amount: order.tax.toFixed(2),
    product_service_charge: (0).toFixed(2),
    product_delivery_charge: order.shippingCost.toFixed(2),
    total_amount: order.total.toFixed(2),
    transaction_uuid: order.orderId,
    product_code: ESEWA_CONFIG.merchantId,
    // eSewa redirects to BACKEND, which processes payment and redirects to FRONTEND
    success_url: `${BACKEND_URL}/api/v1/orders/esewa/success`,
    failure_url: `${BACKEND_URL}/api/v1/orders/esewa/failure`,
    signed_field_names: "total_amount,transaction_uuid,product_code",
  };

  // Generate signature: total_amount,transaction_uuid,product_code
  const message = `total_amount=${data.total_amount},transaction_uuid=${data.transaction_uuid},product_code=${data.product_code}`;
  console.log("ESEWA Signature Message:", message);
  data.signature = generateEsewaSignature(message);
  data.payment_url = ESEWA_CONFIG.paymentUrl;

  return data;
};

// Helper for order notifications
const emitOrderNotifications = (order) => {
  try {
    // 1. User notification (for authenticated users)
    if (order.user) {
      notificationEventEmitter.emit("order:created", {
        userId: order.user,
        orderId: order._id,
        total: order.total,
        paymentMethod: order.paymentMethod,
      });
    }

    // 2. Admin notification
    notificationEventEmitter.emit("admin:order:new", {
      orderId: order._id,
      orderNumber: order.orderId,
      customerName: order.isGuestOrder
        ? `${order.guestInfo.firstName} ${order.guestInfo.lastName}`
        : `${order.guestInfo?.firstName || "Customer"} ${order.guestInfo?.lastName || ""}`,
      customerEmail: order.guestInfo?.email,
      total: order.total,
      paymentMethod: order.paymentMethod,
      itemCount: order.items.length,
    });
  } catch (error) {
    console.error("Failed to emit order notifications:", error.message);
  }
};

// Helper to start sessions conditionally based on whether replica sets are supported
const startTransactionSession = async () => {
  const topologyType = mongoose.connection.client?.topology?.description?.type;
  // If connection is not replica set, sessions are not supported (e.g. standalone local mongo)
  const supportsTransactions = topologyType && topologyType !== 'Single';

  if (!supportsTransactions) {
    return {
      session: null,
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: () => {},
    };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  return session;
};

// ========== GUEST CHECKOUT ==========

exports.guestCheckout = catchAsync(async (req, res, next) => {
  const transaction = await startTransactionSession();
  const { session } = transaction;

  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      items,
      shippingAddress,
      billingAddress,
      useSameAddress,
      paymentMethod,
      discountCode,
      customerNote,
    } = req.body;

    // Prepare order items and validate stock within transaction
    const orderItems = await prepareOrderItems(items, session);

    // Calculate totals within transaction
    const totals = await calculateOrderTotals(
      orderItems,
      discountCode,
      session,
    );

    // Create order within transaction
    const [order] = await Order.create(
      [
        {
          isGuestOrder: true,
          guestInfo: {
            email: email.toLowerCase(),
            firstName,
            lastName,
            phone,
          },
          items: orderItems,
          shippingAddress,
          billingAddress: useSameAddress ? shippingAddress : billingAddress,
          ...totals,
          discountCode: totals.discountInfo,
          paymentMethod,
          paymentStatus: "pending",
          orderStatus: "pending",
          customerNote,
          statusHistory: [{ status: "pending", note: "Order placed" }],
        },
      ],
      session ? { session } : {},
    );

    // Update product stock within transaction (only for non-eSewa orders like COD)
    if (paymentMethod !== "esewa") {
      // FIX: Batch update all products with bulkWrite instead of individual updates (N+1 prevention)
      const bulkOps = orderItems.map((item) => ({
        updateOne: {
          filter: {
            _id: item.product,
            stock: { $gte: item.quantity },
          },
          update: {
            $inc: { stock: -item.quantity },
          },
        },
      }));

      if (bulkOps.length > 0) {
        const result = await Product.bulkWrite(bulkOps, {
          session: session || undefined,
        });

        // Verify all products were updated
        if (result.modifiedCount !== orderItems.length) {
          throw new AppError(
            "Insufficient stock for one or more products in your cart. Please review.",
            400
          );
        }
      }
    }

    // Increment discount usage if applied within transaction
    if (totals.discountInfo) {
      const discount = session
        ? await Discount.findOne({ code: totals.discountInfo.code }).session(session)
        : await Discount.findOne({ code: totals.discountInfo.code });
      if (discount) {
        discount.currentUsageCount += 1;
        await discount.save(session ? { session } : {});
      }
    }

    // Handle eSewa redirection setup
    if (paymentMethod === "esewa") {
      const esewaData = generateEsewaPaymentData(order);
      await transaction.commitTransaction();
      transaction.endSession();

      return res.status(201).json({
        success: true,
        message: "Order created. Proceed to payment.",
        data: {
          order: {
            orderId: order.orderId,
            total: order.total,
          },
          esewa: esewaData,
        },
      });
    }

    // COD: Finalize order status within transaction
    order.orderStatus = "confirmed";
    order.confirmedAt = new Date();
    order.addStatusHistory("confirmed", "Cash on Delivery order confirmed");
    await order.save(session ? { session } : {});

    await transaction.commitTransaction();
    transaction.endSession();

    // After success: Send order confirmation email and notifications
    sendOrderConfirmationEmail(order).catch((err) =>
      console.error(
        `Background email failed for order ${order.orderId}:`,
        err.message,
      ),
    );
    emitOrderNotifications(order);

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      data: {
        order: {
          orderId: order.orderId,
          orderStatus: order.orderStatus,
          paymentMethod: order.paymentMethod,
          total: order.total,
          email: order.guestInfo.email,
        },
        emailSent: true,
      },
    });
  } catch (error) {
    await transaction.abortTransaction();
    transaction.endSession();
    return next(error);
  }
});

// ========== AUTHENTICATED CHECKOUT ==========

exports.authenticatedCheckout = catchAsync(async (req, res, next) => {
  const transaction = await startTransactionSession();
  const { session } = transaction;

  try {
    const userId = req.user._id;
    const {
      shippingAddressId,
      shippingAddress,
      billingAddressId,
      billingAddress,
      useSameAddress,
      paymentMethod,
      discountCode,
      customerNote,
    } = req.body;

    // Get user's cart within transaction
    const cartQuery = Cart.findOne({ user: userId }).populate("items.product");
    const cart = session ? await cartQuery.session(session) : await cartQuery;
    
    if (!cart || cart.items.length === 0) {
      await transaction.abortTransaction();
      transaction.endSession();
      return next(new AppError("Your cart is empty", 400));
    }

    // Prepare items from cart
    const items = cart.items.map((item) => ({
      productId: item.product._id,
      quantity: item.quantity,
      variant: item.variant,
    }));

    const orderItems = await prepareOrderItems(items, session);

    // Get shipping address
    let finalShippingAddress;
    if (shippingAddressId) {
      const addressQuery = Address.findOne({
        _id: shippingAddressId,
        user: userId,
      });
      const savedAddress = session ? await addressQuery.session(session) : await addressQuery;
      
      if (!savedAddress) {
        await transaction.abortTransaction();
        transaction.endSession();
        return next(new AppError("Shipping address not found", 404));
      }
      finalShippingAddress = {
        fullName: savedAddress.fullName,
        phone: savedAddress.phone,
        addressLine1: savedAddress.addressLine1,
        addressLine2: savedAddress.addressLine2 || "",
        city: savedAddress.city,
        state: savedAddress.state || "",
        postalCode: savedAddress.postalCode,
        country: savedAddress.country,
      };
    } else {
      finalShippingAddress = shippingAddress;
    }

    // Get billing address
    let finalBillingAddress = finalShippingAddress;
    if (!useSameAddress) {
      if (billingAddressId) {
        const billingQuery = Address.findOne({
          _id: billingAddressId,
          user: userId,
        });
        const savedBilling = session ? await billingQuery.session(session) : await billingQuery;
        
        if (savedBilling) {
          finalBillingAddress = {
            fullName: savedBilling.fullName,
            phone: savedBilling.phone,
            addressLine1: savedBilling.addressLine1,
            addressLine2: savedBilling.addressLine2 || "",
            city: savedBilling.city,
            state: savedBilling.state || "",
            postalCode: savedBilling.postalCode,
            country: savedBilling.country,
          };
        }
      } else if (billingAddress) {
        finalBillingAddress = billingAddress;
      }
    }

    // Calculate totals
    const totals = await calculateOrderTotals(
      orderItems,
      discountCode,
      session,
    );

    // Create order within transaction
    const [order] = await Order.create(
      [
        {
          user: userId,
          isGuestOrder: false,
          guestInfo: {
            email: req.user.email,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
            phone: req.user.phone || "",
          },
          items: orderItems,
          shippingAddress: finalShippingAddress,
          billingAddress: finalBillingAddress,
          ...totals,
          discountCode: totals.discountInfo,
          paymentMethod,
          paymentStatus: "pending",
          orderStatus: "pending",
          customerNote,
          statusHistory: [{ status: "pending", note: "Order placed" }],
        },
      ],
      session ? { session } : {},
    );

    // Update stock within transaction (only for non-eSewa orders like COD)
    if (paymentMethod !== "esewa") {
      // FIX: Batch update all products with bulkWrite instead of individual updates (N+1 prevention)
      const bulkOps = orderItems.map((item) => ({
        updateOne: {
          filter: {
            _id: item.product,
            stock: { $gte: item.quantity },
          },
          update: {
            $inc: { stock: -item.quantity },
          },
        },
      }));

      if (bulkOps.length > 0) {
        const result = await Product.bulkWrite(bulkOps, {
          session: session || undefined,
        });

        // Verify all products were updated
        if (result.modifiedCount !== orderItems.length) {
          throw new AppError(
            "Insufficient stock for one or more products in your cart. Please review.",
            400
          );
        }
      }
    }

    // Increment discount usage within transaction
    if (totals.discountInfo) {
      const discount = session
        ? await Discount.findOne({ code: totals.discountInfo.code }).session(session)
        : await Discount.findOne({ code: totals.discountInfo.code });
      if (discount) {
        discount.currentUsageCount += 1;
        await discount.save(session ? { session } : {});
      }
    }

    // Clear user's cart within transaction (only for non-eSewa orders like COD)
    if (paymentMethod !== "esewa") {
      await cart.clearCart(session ? { session } : {});
    }

    // Handle payment
    if (paymentMethod === "esewa") {
      const esewaData = generateEsewaPaymentData(order);
      await transaction.commitTransaction();
      transaction.endSession();

      return res.status(201).json({
        success: true,
        message: "Order created. Proceed to payment.",
        data: {
          order: { orderId: order.orderId, total: order.total },
          esewa: esewaData,
        },
      });
    }

    // COD: Confirm order
    order.orderStatus = "confirmed";
    order.confirmedAt = new Date();
    order.addStatusHistory("confirmed", "Cash on Delivery order confirmed");
    await order.save(session ? { session } : {});

    await transaction.commitTransaction();
    transaction.endSession();

    // After success: Send order confirmation email and notifications
    sendOrderConfirmationEmail(order).catch((err) =>
      console.error(
        `Background email failed for order ${order.orderId}:`,
        err.message,
      ),
    );
    emitOrderNotifications(order);

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      data: {
        order: {
          orderId: order.orderId,
          orderStatus: order.orderStatus,
          paymentMethod: order.paymentMethod,
          total: order.total,
          email: order.guestInfo.email,
        },
        emailSent: true,
      },
    });
  } catch (error) {
    await transaction.abortTransaction();
    transaction.endSession();
    return next(error);
  }
});

// ========== ORDER TRACKING ==========

exports.trackOrder = catchAsync(async (req, res, next) => {
  const { orderId, email } = req.body;

  const order = await Order.findOne({
    orderId: orderId.toUpperCase(),
    "guestInfo.email": email.toLowerCase(),
  }).select("-adminNote");

  if (!order) {
    return next(
      new AppError(
        "Order not found. Please check your order ID and email.",
        404,
      ),
    );
  }

  res.status(200).json({
    success: true,
    data: { order },
  });
});

// ========== USER ORDER HISTORY ==========

exports.getMyOrders = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, status } = req.query;

  const filter = {
    user: req.user._id,
    $or: [
      { paymentMethod: "cod" },
      { paymentMethod: "esewa", paymentStatus: { $ne: "pending" } },
    ],
  };
  if (status) filter.orderStatus = status;

  const skip = (page - 1) * limit;

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select("-adminNote"),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    },
  });
});

exports.getOrder = catchAsync(async (req, res, next) => {
  const order = await Order.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select("-adminNote");

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  res.status(200).json({
    success: true,
    data: { order },
  });
});

// ========== ADMIN OPERATIONS ==========

exports.getAllOrders = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status, paymentStatus, search } = req.query;

  const filter = {};
  if (status) filter.orderStatus = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (search) {
    filter.$or = [
      { orderId: { $regex: search, $options: "i" } },
      { "guestInfo.email": { $regex: search, $options: "i" } },
      { "guestInfo.firstName": { $regex: search, $options: "i" } },
      { "guestInfo.lastName": { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Calculate stats for all orders matching the filter (not just paginated)
  // Revenue only counts orders that are paid and not cancelled/refunded
  const statsAggregation = await Order.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        // Only count revenue for paid orders that are not cancelled or refunded
        totalRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$paymentStatus", "paid"] },
                  {
                    $not: { $in: ["$orderStatus", ["cancelled", "refunded"]] },
                  },
                ],
              },
              "$total",
              0,
            ],
          },
        },
        totalOrders: { $sum: 1 },
        // Pending revenue: orders with pending payment that aren't cancelled
        pendingRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$paymentStatus", "pending"] },
                  { $ne: ["$orderStatus", "cancelled"] },
                ],
              },
              "$total",
              0,
            ],
          },
        },
        // Refunded amount
        refundedAmount: {
          $sum: {
            $cond: [{ $eq: ["$paymentStatus", "refunded"] }, "$total", 0],
          },
        },
      },
    },
  ]);

  const stats = statsAggregation[0] || {
    totalRevenue: 0,
    totalOrders: 0,
    pendingRevenue: 0,
    refundedAmount: 0,
  };

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate("user", "firstName lastName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Order.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    data: {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
      stats: {
        totalRevenue: stats.totalRevenue,
        pendingRevenue: stats.pendingRevenue,
        refundedAmount: stats.refundedAmount,
      },
    },
  });
});

exports.getOrderAdmin = catchAsync(async (req, res, next) => {
  const order = await Order.findById(req.params.id).populate(
    "user",
    "firstName lastName email phone",
  );

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  res.status(200).json({
    success: true,
    data: { order },
  });
});

exports.updateOrderStatus = catchAsync(async (req, res, next) => {
  const { status, note } = req.body;

  const order = await Order.findById(req.params.id);
  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  // Update timestamps based on status
  const statusTimestamps = {
    confirmed: "confirmedAt",
    shipped: "shippedAt",
    delivered: "deliveredAt",
    cancelled: "cancelledAt",
  };

  if (statusTimestamps[status]) {
    order[statusTimestamps[status]] = new Date();
  }

  // If delivered and COD, mark as paid
  if (status === "delivered" && order.paymentMethod === "cod") {
    order.paymentStatus = "paid";
    order.paymentDetails = {
      ...order.paymentDetails,
      paidAt: new Date(),
    };
  }

  // If cancelled, restore stock
  if (status === "cancelled" && order.orderStatus !== "cancelled") {
    // FIX: Batch restore stock with bulkWrite instead of individual updates (N+1 prevention)
    const bulkOps = order.items.map((item) => ({
      updateOne: {
        filter: { _id: item.product },
        update: { $inc: { stock: item.quantity } },
      },
    }));

    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps);
    }
  }

  order.addStatusHistory(status, note || `Status updated to ${status}`);
  const previousStatus = order.orderStatus;
  await order.save();

  // Emit order:statusChanged notification event
  try {
    const notificationPayload = {
      orderId: order._id,
      status: status,
      previousStatus: previousStatus,
      trackingNumber: order.trackingNumber || null,
    };

    // For authenticated users, include userId
    if (order.user) {
      notificationPayload.userId = order.user;
    } else if (order.guestInfo?.email) {
      // For guest orders, we'll use email as identifier
      notificationPayload.guestEmail = order.guestInfo.email;
    }

    notificationEventEmitter.emit("order:statusChanged", notificationPayload);
  } catch (error) {
    console.error("Failed to emit order:statusChanged event:", error.message);
  }

  res.status(200).json({
    success: true,
    message: "Order status updated",
    data: { order },
  });
});

// ========== ESEWA CALLBACKS (ePay v2) ==========

exports.esewaSuccess = catchAsync(async (req, res, next) => {
  // eSewa v2 returns Base64 encoded data in query parameter
  const { data } = req.query;

  if (!data) {
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=missing_data`,
    );
  }

  let responseData;
  try {
    // Decode Base64 response
    const decodedData = Buffer.from(data, "base64").toString("utf-8");
    responseData = JSON.parse(decodedData);
  } catch (error) {
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=invalid_response`,
    );
  }

  const { transaction_uuid, status, total_amount, transaction_code } =
    responseData;

  // Verify signature
  if (!verifyEsewaSignature(responseData)) {
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=signature_mismatch`,
    );
  }

  // Find the order
  const order = await Order.findOne({ orderId: transaction_uuid });
  if (!order) {
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=order_not_found`,
    );
  }

  // Check payment status
  if (status !== "COMPLETE") {
    order.paymentStatus = "failed";
    order.addStatusHistory("pending", `eSewa payment status: ${status}`);
    await order.save();
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=payment_incomplete`,
    );
  }

  // Update order with successful payment
  // ATOMIC STOCK DEDUCTION (Deferred model: Stock is only decremented now that payment succeeded)
  try {
    for (const item of order.items) {
      const updatedProduct = await Product.findOneAndUpdate(
        {
          _id: item.product,
          stock: { $gte: item.quantity },
        },
        {
          $inc: { stock: -item.quantity },
        },
        { new: true },
      );

      if (!updatedProduct) {
        order.paymentStatus = "failed";
        order.orderStatus = "cancelled";
        order.addStatusHistory("cancelled", "Order failed: Out of stock during eSewa payment capture");
        await order.save();
        return res.redirect(
          `${FRONTEND_URL}/checkout/payment-failed?error=out_of_stock`,
        );
      }
    }
  } catch (err) {
    console.error("Stock deduction failure during eSewa checkout confirmation:", err.message);
    return res.redirect(
      `${FRONTEND_URL}/checkout/payment-failed?error=internal_stock_error`,
    );
  }

  order.paymentStatus = "paid";
  order.paymentDetails = {
    transactionId: transaction_code,
    esewaRefId: transaction_code,
    paidAt: new Date(),
    paymentGatewayResponse: responseData,
  };
  order.orderStatus = "confirmed";
  order.confirmedAt = new Date();
  order.addStatusHistory("confirmed", "Payment confirmed via eSewa");
  await order.save();

  // Clear user's cart now that the payment was successfully captured
  if (order.user) {
    try {
      const cart = await Cart.findOne({ user: order.user });
      if (cart) {
        await cart.clearCart();
        console.log(`[eSewa Success] Cleared cart for user ID: ${order.user}`);
      }
    } catch (cartErr) {
      console.error(`[eSewa Success] Failed to clear cart for user ID ${order.user}:`, cartErr.message);
    }
  }

  // Send order confirmation email in background
  sendOrderConfirmationEmail(order).catch((err) =>
    console.error(
      `Background email failed for order ${order.orderId}:`,
      err.message,
    ),
  );

  // Emit notifications after successful eSewa payment
  emitOrderNotifications(order);

  res.redirect(
    `${FRONTEND_URL}/order-confirmation/${order.orderId}?email=${encodeURIComponent(order.guestInfo.email)}&emailSent=true`,
  );
});

exports.esewaFailure = catchAsync(async (req, res, next) => {
  const { data } = req.query;

  let transaction_uuid = null;

  if (data) {
    try {
      const decodedData = Buffer.from(data, "base64").toString("utf-8");
      const responseData = JSON.parse(decodedData);
      transaction_uuid = responseData.transaction_uuid;
    } catch (error) {
      // If decoding fails, try to get from other query params
    }
  }

  if (transaction_uuid) {
    const order = await Order.findOne({ orderId: transaction_uuid });
    if (order && order.paymentStatus === "pending") {
      order.paymentStatus = "failed";
      order.orderStatus = "cancelled"; // Mark order as cancelled
      order.addStatusHistory("cancelled", "Payment failed/cancelled via eSewa");
      await order.save();
    }
  }

  res.redirect(
    `${FRONTEND_URL}/checkout/payment-failed?orderId=${transaction_uuid || ""}`,
  );
});

exports.cancelOrder = catchAsync(async (req, res, next) => {
  const order = await Order.findById(req.params.id).populate(
    "user",
    "firstName lastName email",
  );

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (order.user && order.user._id.toString() !== req.user.id) {
    return next(new AppError("You can only cancel your own orders", 403));
  }

  if (
    order.orderStatus === "shipped" ||
    order.orderStatus === "delivered" ||
    order.orderStatus === "cancelled"
  ) {
    return next(
      new AppError(`Cannot cancel order that is ${order.orderStatus}`, 400),
    );
  }

  order.orderStatus = "cancelled";
  order.cancelledAt = new Date();
  order.addStatusHistory("cancelled", req.body.reason || "Cancelled by user");

  if (order.paymentStatus === "paid" || order.paymentStatus === "pending") {
    order.paymentStatus = "refunded";
  }

  // FIX: Batch restore stock with bulkWrite instead of individual updates (N+1 prevention)
  const bulkOps = order.items.map((item) => ({
    updateOne: {
      filter: { _id: item.product },
      update: { $inc: { stock: item.quantity } },
    },
  }));

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps);
  }

  await order.save();

  notificationEventEmitter.emit("order.cancelled", {
    orderId: order._id,
    userId: order.user?._id,
    email: order.user?.email || order.guestInfo?.email,
    orderNumber: order.orderId,
  });

  // Emit admin notification for cancelled order
  notificationEventEmitter.emit("admin:order:cancelled", {
    orderId: order._id,
    orderNumber: order.orderId,
    customerName: order.user
      ? `${order.user.firstName} ${order.user.lastName}`
      : `${order.guestInfo?.firstName} ${order.guestInfo?.lastName}`,
    customerEmail: order.user?.email || order.guestInfo?.email,
    reason: req.body.reason || "Not specified",
    total: order.total,
  });

  res.status(200).json({
    success: true,
    message: "Order cancelled successfully",
    data: { order },
  });
});

exports.requestReturn = catchAsync(async (req, res, next) => {
  const { reason, description } = req.body;

  if (!reason) {
    return next(new AppError("Return reason is required", 400));
  }

  const order = await Order.findById(req.params.id).populate(
    "user",
    "firstName lastName email",
  );

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (order.user && order.user._id.toString() !== req.user.id) {
    return next(
      new AppError("You can only request return for your own orders", 403),
    );
  }

  if (order.orderStatus !== "delivered") {
    return next(
      new AppError("Return can only be requested for delivered orders", 400),
    );
  }

  if (order.returnRequest?.status && order.returnRequest.status !== "none") {
    return next(
      new AppError(`Return request already ${order.returnRequest.status}`, 400),
    );
  }

  const deliveredDate = order.deliveredAt || order.updatedAt;
  const daysSinceDelivery = Math.floor(
    (Date.now() - new Date(deliveredDate)) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceDelivery > 7) {
    return next(
      new AppError("Return window has expired (7 days after delivery)", 400),
    );
  }

  order.returnRequest = {
    status: "requested",
    reason,
    description: description || "",
    requestedAt: new Date(),
  };

  order.addStatusHistory("delivered", `Return requested: ${reason}`);
  await order.save();

  notificationEventEmitter.emit("order.returnRequested", {
    orderId: order._id,
    userId: order.user?._id,
    email: order.user?.email || order.guestInfo?.email,
    orderNumber: order.orderId,
    reason,
  });

  // Emit admin notification for return request
  notificationEventEmitter.emit("admin:return:requested", {
    orderId: order._id,
    orderNumber: order.orderId,
    customerName: order.user
      ? `${order.user.firstName} ${order.user.lastName}`
      : `${order.guestInfo?.firstName} ${order.guestInfo?.lastName}`,
    customerEmail: order.user?.email || order.guestInfo?.email,
    reason,
  });

  res.status(200).json({
    success: true,
    message: "Return request submitted successfully",
    data: { order },
  });
});

exports.processReturnRequest = catchAsync(async (req, res, next) => {
  const { status, adminNote } = req.body;

  if (!status || !["approved", "rejected"].includes(status)) {
    return next(
      new AppError("Valid status (approved/rejected) is required", 400),
    );
  }

  const order = await Order.findById(req.params.id).populate(
    "user",
    "firstName lastName email",
  );

  if (!order) {
    return next(new AppError("Order not found", 404));
  }

  if (!order.returnRequest || order.returnRequest.status !== "requested") {
    return next(new AppError("No pending return request found", 400));
  }

  order.returnRequest.status = status;
  order.returnRequest.processedAt = new Date();
  order.returnRequest.adminNote = adminNote || "";

  if (status === "approved") {
    order.addStatusHistory(
      "delivered",
      `Return approved: ${adminNote || "Approved by admin"}`,
    );

    if (order.paymentStatus === "paid") {
      order.paymentStatus = "refunded";
    }

    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity },
      });
    }
  } else {
    order.addStatusHistory(
      "delivered",
      `Return rejected: ${adminNote || "Rejected by admin"}`,
    );
  }

  await order.save();

  notificationEventEmitter.emit("order.returnProcessed", {
    orderId: order._id,
    userId: order.user?._id,
    email: order.user?.email || order.guestInfo?.email,
    orderNumber: order.orderId,
    status,
    adminNote,
  });

  res.status(200).json({
    success: true,
    message: `Return request ${status} successfully`,
    data: { order },
  });
});
