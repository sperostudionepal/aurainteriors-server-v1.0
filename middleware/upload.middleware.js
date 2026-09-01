const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const crypto = require("crypto");
const AppError = require("../utils/AppError");
const { uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");

const generatePublicId = (prefix) => {
  const uniqueId = crypto.randomBytes(8).toString("hex");
  return `${prefix}-${Date.now()}-${uniqueId}`;
};

const multerStorage = multer.memoryStorage();

const multerFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image")) {
    cb(null, true);
  } else {
    cb(new AppError("Please upload only images", 400), false);
  }
};

const modelFileFilter = (req, file, cb) => {
  if (file.fieldname === "images") {
    if (file.mimetype.startsWith("image")) {
      cb(null, true);
    } else {
      cb(new AppError("Please upload only images for the images field", 400), false);
    }
  } else if (file.fieldname === "modelFiles") {
    const allowedExtensions = [".glb", ".gltf", ".usdz"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new AppError("Please upload only .glb, .gltf, or .usdz files for 3D models", 400), false);
    }
  } else {
    cb(null, true);
  }
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // Increased to 20MB
});

const productUpload = multer({
  storage: multerStorage,
  fileFilter: modelFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

exports.uploadAvatar = upload.single("avatar");

exports.resizeAvatar = async (req, res, next) => {
  try {
    if (!req.file) return next();

    const resizedBuffer = await sharp(req.file.buffer)
      .resize(400, 400, { fit: "cover" })
      .toFormat("jpeg")
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await uploadToCloudinary(resizedBuffer, {
      folder: "aura/avatars",
      public_id: generatePublicId(`user-${req.user.id}`),
      resource_type: "image",
    });

    req.file.cloudinaryUrl = result.secure_url;
    req.file.cloudinaryPublicId = result.public_id;

    next();
  } catch (error) {
    console.error("Avatar upload error:", error);
    next(new AppError("Error processing image. Please try again.", 500));
  }
};

exports.uploadCategoryImage = upload.single("image");

exports.uploadBlogImage = upload.single("featuredImage");

exports.resizeBlogImage = async (req, res, next) => {
  try {
    if (!req.file) return next();

    const resizedBuffer = await sharp(req.file.buffer)
      .resize(1200, 630, { fit: "cover" })
      .toFormat("jpeg")
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await uploadToCloudinary(resizedBuffer, {
      folder: "aura/blogs",
      public_id: generatePublicId("blog"),
      resource_type: "image",
    });

    req.file.cloudinaryUrl = result.secure_url;
    req.file.cloudinaryPublicId = result.public_id;

    next();
  } catch (error) {
    console.error("Blog image upload error:", error);
    next(new AppError("Error processing image. Please try again.", 500));
  }
};

exports.resizeCategoryImage = async (req, res, next) => {
  try {
    if (!req.file) return next();

    // Upload image as-is without any transformation
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "aura/categories",
      public_id: generatePublicId("category"),
      resource_type: "image",
    });

    req.file.cloudinaryUrl = result.secure_url;
    req.file.cloudinaryPublicId = result.public_id;

    next();
  } catch (error) {
    console.error("Category image upload error:", error);
    next(new AppError("Error processing image. Please try again.", 500));
  }
};

exports.uploadProductImages = upload.array("images", 10);

exports.uploadProductFiles = productUpload.fields([
  { name: "images", maxCount: 10 },
  { name: "modelFiles", maxCount: 5 },
]);

exports.resizeProductImages = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) return next();

    await Promise.all(
      req.files.map(async (file) => {
        const originalSize = file.buffer.length;
        
        // OPTIMIZATION: Product image compression (Phase 2)
        // Resize to max 1200x1200 and compress to 80% quality
        // - Imperceptible quality loss for product images
        // - 60-85% size reduction vs original
        const resizedBuffer = await sharp(file.buffer)
          .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
          .toFormat("jpeg")
          .jpeg({ quality: 80, progressive: true }) // Changed from 90 to 80, added progressive
          .toBuffer();

        const compressedSize = resizedBuffer.length;
        const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);
        
        console.log(
          `[Product Image Compression] ${file.originalname}: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (${reduction}% reduction)`
        );

        const result = await uploadToCloudinary(resizedBuffer, {
          folder: "aura/products",
          public_id: generatePublicId("product"),
          resource_type: "image",
        });

        file.cloudinaryUrl = result.secure_url;
        file.cloudinaryPublicId = result.public_id;
      })
    );

    next();
  } catch (error) {
    console.error("Product images upload error:", error);
    next(new AppError("Error processing images. Please try again.", 500));
  }
};

exports.processProductFiles = async (req, res, next) => {
  try {
    if (req.files?.images && req.files.images.length > 0) {
      await Promise.all(
        req.files.images.map(async (file) => {
          const originalSize = file.buffer.length;
          
          // OPTIMIZATION: Product image compression (Phase 2)
          // Resize to max 1200x1200 and compress to 80% quality
          const resizedBuffer = await sharp(file.buffer)
            .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
            .toFormat("jpeg")
            .jpeg({ quality: 80, progressive: true }) // Changed from 90 to 80, added progressive
            .toBuffer();

          const compressedSize = resizedBuffer.length;
          const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);
          
          console.log(
            `[Product Image Compression] ${file.originalname}: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (${reduction}% reduction)`
          );

          const result = await uploadToCloudinary(resizedBuffer, {
            folder: "aura/products",
            public_id: generatePublicId("product"),
            resource_type: "image",
          });

          file.cloudinaryUrl = result.secure_url;
          file.cloudinaryPublicId = result.public_id;
        })
      );
    }

    if (req.files?.modelFiles && req.files.modelFiles.length > 0) {
      await Promise.all(
        req.files.modelFiles.map(async (file) => {
          const ext = path.extname(file.originalname).toLowerCase();
          const cleanExt = ext.replace(".", "");
          const publicId = `${generatePublicId("model")}.${cleanExt}`;

          const result = await uploadToCloudinary(file.buffer, {
            folder: "aura/models",
            public_id: publicId,
            resource_type: "raw",
          });

          file.cloudinaryUrl = result.secure_url;
          file.cloudinaryPublicId = result.public_id;
          file.fileSize = file.size;
          file.format = cleanExt;

          if (cleanExt === "usdz") {
            file.platform = "ios";
          } else if (cleanExt === "glb" || cleanExt === "gltf") {
            file.platform = "android";
          } else {
            file.platform = "universal";
          }
        })
      );
    }

    next();
  } catch (error) {
    console.error("Error processing product files:", error);
    next(new AppError("Error processing files. Please try again.", 500));
  }
};

exports.deleteFile = async (publicId, resourceType = "image") => {
  return deleteFromCloudinary(publicId, resourceType);
};

exports.deleteFiles = async (publicIds, resourceType = "image") => {
  await Promise.all(publicIds.map((id) => deleteFromCloudinary(id, resourceType)));
};

const chatAttachmentFilter = (req, file, cb) => {
  const allowedImageTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
  const allowedDocTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
    "application/json",
  ];

  if (allowedImageTypes.includes(file.mimetype) || allowedDocTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        "Only images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, XLS, XLSX, TXT, CSV, JSON) are allowed",
        400
      ),
      false
    );
  }
};

const chatUpload = multer({
  storage: multerStorage,
  fileFilter: chatAttachmentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

exports.uploadChatAttachment = chatUpload.array("attachments", 3);

exports.processChatAttachment = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      req.processedAttachments = [];
      return next();
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        // For images, do light optimization only if file is large
        let uploadBuffer = file.buffer;
        if (file.mimetype.startsWith("image") && file.size > 2 * 1024 * 1024) {
          // Only compress if larger than 2MB
          try {
            uploadBuffer = await sharp(file.buffer)
              .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
              .toFormat("jpeg", { progressive: true, quality: 80 })
              .toBuffer();
          } catch (sharpError) {
            // If sharp processing fails, use original buffer
            console.warn("Sharp processing failed, using original buffer:", sharpError.message);
            uploadBuffer = file.buffer;
          }
        }

        const result = await uploadToCloudinary(uploadBuffer, {
          folder: "aura/chat",
          public_id: generatePublicId(file.mimetype.startsWith("image") ? "chat-img" : "chat-doc"),
          resource_type: file.mimetype.startsWith("image") ? "image" : "auto",
          quality: "auto", // Let Cloudinary auto-optimize
        });

        // Determine file type based on MIME type or extension
        let fileType = "document";
        if (file.mimetype.startsWith("image")) {
          fileType = "image";
        } else {
          const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
          fileType = 
            ext === "pdf" ? "pdf" :
            ext === "csv" ? "csv" :
            ext === "json" ? "json" :
            ext === "txt" ? "text" :
            ext === "xls" || ext === "xlsx" ? "spreadsheet" :
            "document";
        }

        processedFiles.push({
          fileName: file.originalname,
          fileUrl: result.secure_url,
          cloudinaryPublicId: result.public_id,
          fileType,
          fileSize: file.size,
        });
      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError);
        // Continue processing other files instead of failing completely
      }
    }

    req.processedAttachments = processedFiles;
    next();
  } catch (error) {
    console.error("Error processing chat attachments:", error);
    next(new AppError("Error processing attachments. Please try again.", 500));
  }
};

const documentFilter = (req, file, cb) => {
  const allowedDocTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/csv",
  ];

  if (allowedDocTypes.includes(file.mimetype) || file.originalname.endsWith(".csv") || file.originalname.endsWith(".txt")) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        "Only PDF, DOCX, TXT, and CSV documents are allowed",
        400
      ),
      false
    );
  }
};

const documentUpload = multer({
  storage: multerStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

exports.uploadDocumentFile = documentUpload.single("file");

exports.processDocumentFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(new AppError("Please upload a file", 400));
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const cleanExt = ext.replace(".", "");
    const publicId = `${generatePublicId("doc")}.${cleanExt}`;

    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "aura/knowledge_base",
      public_id: publicId,
      resource_type: "raw",
      type: "authenticated",
    });

    req.processedDocument = {
      fileName: req.file.originalname,
      fileUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      fileType: cleanExt === "docx" ? "docx" : cleanExt === "pdf" ? "pdf" : cleanExt === "csv" ? "csv" : "txt",
    };

    next();
  } catch (error) {
    console.error("Error processing document:", error);
    next(new AppError("Error uploading document to Cloudinary", 500));
  }
};

