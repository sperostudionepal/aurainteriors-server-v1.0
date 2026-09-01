/**
 * Image Compression Utility for Backend (Node.js)
 * 
 * Compresses images before upload to reduce bandwidth and storage costs.
 * Used for:
 * 1. Product images (via admin upload)
 * 2. Category images (via admin upload)
 * 3. Seed data images (downloading from URLs and compressing)
 * 
 * Compression strategy: Max 1200x1200px @ 80% JPEG quality
 * - Imperceptible quality loss
 * - 60-85% size reduction for typical furniture photos
 */

const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Compress image buffer and return as JPEG
 * 
 * @param {Buffer} imageBuffer - The image buffer to compress
 * @param {Object} options - Compression options
 * @returns {Promise<Buffer>} - Compressed image buffer
 */
const compressImageBuffer = async (imageBuffer, options = {}) => {
  const {
    maxWidth = 1200,
    maxHeight = 1200,
    quality = 80, // JPEG quality (80% is sweet spot)
  } = options;

  try {
    const compressed = await sharp(imageBuffer)
      .resize(maxWidth, maxHeight, {
        fit: 'inside', // Maintains aspect ratio, doesn't enlarge
        withoutEnlargement: true, // Don't upscale small images
      })
      .jpeg({ quality, progressive: true }) // Progressive JPEG for faster perceived load
      .toBuffer();

    return compressed;
  } catch (error) {
    console.error('Sharp compression error:', error);
    // Fallback: return original buffer if compression fails
    return imageBuffer;
  }
};

/**
 * Compress image from file path
 * 
 * @param {string} filePath - Path to the image file
 * @param {Object} options - Compression options
 * @returns {Promise<Buffer>} - Compressed image buffer
 */
const compressImageFile = async (filePath, options = {}) => {
  try {
    const imageBuffer = await fs.promises.readFile(filePath);
    return await compressImageBuffer(imageBuffer, options);
  } catch (error) {
    console.error(`Failed to compress image from ${filePath}:`, error);
    throw error;
  }
};

/**
 * Download image from URL and compress it
 * 
 * Used in seed script to download Unsplash images and compress before storing
 * 
 * @param {string} imageUrl - URL to the image
 * @param {Object} options - Compression options
 * @returns {Promise<Buffer>} - Compressed image buffer
 */
const compressImageFromUrl = async (imageUrl, options = {}) => {
  try {
    // Download image from URL
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000, // 10 second timeout
    });

    const imageBuffer = Buffer.from(response.data, 'binary');
    
    // Log original size
    const originalSize = imageBuffer.length;
    
    // Compress the buffer
    const compressed = await compressImageBuffer(imageBuffer, options);
    
    // Log compression results
    const compressedSize = compressed.length;
    const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    
    console.log(
      `Downloaded & compressed: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (${reduction}% reduction)`
    );
    
    return compressed;
  } catch (error) {
    console.error(`Failed to compress image from URL ${imageUrl}:`, error.message);
    throw error;
  }
};

/**
 * Compress image and get metrics for logging
 * 
 * @param {Buffer} imageBuffer - The image buffer
 * @param {string} sourceName - Name for logging (e.g., "product-sofa.jpg")
 * @param {Object} options - Compression options
 * @returns {Promise<{buffer: Buffer, originalSize: number, compressedSize: number, reduction: string}>}
 */
const compressImageWithMetrics = async (imageBuffer, sourceName, options = {}) => {
  const originalSize = imageBuffer.length;
  const compressed = await compressImageBuffer(imageBuffer, options);
  const compressedSize = compressed.length;
  const reduction = ((1 - compressedSize / originalSize) * 100).toFixed(1);
  
  console.log(
    `[Compression] ${sourceName}: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (${reduction}% reduction)`
  );
  
  return {
    buffer: compressed,
    originalSize,
    compressedSize,
    reduction,
  };
};

/**
 * Get compression stats without actually compressing
 * Useful for seed script to estimate space savings
 * 
 * @param {Buffer} imageBuffer - The image buffer
 * @returns {Promise<{original: number, estimated: number, estimatedReduction: string}>}
 */
const estimateCompressionSavings = async (imageBuffer) => {
  try {
    // Create a test compressed version to estimate size
    const estimated = await compressImageBuffer(imageBuffer, {
      maxWidth: 1200,
      maxHeight: 1200,
      quality: 80,
    });
    
    const originalSize = imageBuffer.length;
    const estimatedSize = estimated.length;
    const reduction = ((1 - estimatedSize / originalSize) * 100).toFixed(1);
    
    return {
      original: originalSize,
      estimated: estimatedSize,
      estimatedReduction: reduction,
    };
  } catch (error) {
    console.error('Failed to estimate compression:', error);
    return null;
  }
};

module.exports = {
  compressImageBuffer,
  compressImageFile,
  compressImageFromUrl,
  compressImageWithMetrics,
  estimateCompressionSavings,
};
