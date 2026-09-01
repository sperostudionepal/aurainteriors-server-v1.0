const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");

const getCloudinaryConfig = () => {
    if (!cloudinary.config().cloud_name) {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
        });
    }
    return cloudinary;
};

const uploadToCloudinary = async (buffer, options = {}) => {
    const client = getCloudinaryConfig();
    return new Promise((resolve, reject) => {
        const uploadStream = client.uploader.upload_stream(
            options,
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

const deleteFromCloudinary = async (publicId, resourceType = "image") => {
    const client = getCloudinaryConfig();
    try {
        const result = await client.uploader.destroy(publicId, {
            resource_type: resourceType,
        });
        return result;
    } catch (error) {
        console.error(`Failed to delete from Cloudinary: ${publicId}`, error.message);
        return null;
    }
};

/**
 * Generate an unsigned upload signature for client-side direct uploads
 * Uses Cloudinary's unsigned upload feature (requires upload_preset)
 */
const generateUploadSignature = (folder = "aura/chat") => {
    // For unsigned uploads, we just need to return upload credentials
    // Cloudinary will accept files directly without signature verification
    return {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        folder,
        uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || "aura_unsigned", // Must be configured in Cloudinary dashboard
    };
};

module.exports = {
    cloudinary,
    getCloudinaryConfig,
    uploadToCloudinary,
    deleteFromCloudinary,
    generateUploadSignature,
};
