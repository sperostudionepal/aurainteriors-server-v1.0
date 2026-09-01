require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Category = require("../models/category.model");
const Product = require("../models/product.model");
const Order = require("../models/order.model");
const { compressImageFromUrl } = require("../utils/imageCompression");

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/aura-interiors";
    await mongoose.connect(mongoUri);
    console.log("✓ Connected to MongoDB for seeding...");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
};

const furnitureImages = {
  sofas: [
    "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80"
  ],
  beds: [
    "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1532372320572-cda25653a26d?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1617806118233-18e1de247200?auto=format&fit=crop&w=1200&q=80"
  ],
  dining: [
    "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80"
  ],
  chairs: [
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1200&q=80"
  ],
  decor: [
    "https://images.unsplash.com/photo-1532372320572-cda25653a26d?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1617806118233-18e1de247200?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80"
  ],
  lighting: [
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=1200&q=80"
  ]
};

const runSeeder = async () => {
  try {
    await connectDB();

    // 1. Seed Admin User if not exists
    console.log("Checking Admin User...");
    const adminEmail = process.env.ADMIN_EMAIL || "admin@aurainteriors.com";
    let adminUser = await User.findOne({ email: adminEmail });
    if (!adminUser) {
      adminUser = new User({
        firstName: "Admin",
        lastName: "User",
        email: adminEmail,
        password: "password123",
        role: "admin",
        phone: "9800000000",
        isEmailVerified: true,
        isActive: true,
      });
      await adminUser.save();
      console.log(`✓ Admin user created: ${adminEmail} (password123)`);
    } else {
      adminUser.password = "password123";
      await adminUser.save();
      console.log(`✓ Admin user exists: ${adminEmail} (password updated)`);
    }

    // 2. Seed Customer User if not exists
    console.log("Checking Customer User...");
    const customerEmail = "customer@aurainteriors.com";
    let customerUser = await User.findOne({ email: customerEmail });
    if (!customerUser) {
      customerUser = new User({
        firstName: "Saugat",
        lastName: "Shahi",
        email: customerEmail,
        password: "password123",
        role: "customer",
        phone: "9877665544",
        isEmailVerified: true,
        isActive: true,
      });
      await customerUser.save();
      console.log(`✓ Customer user created: ${customerEmail} (password123)`);
    } else {
      customerUser.password = "password123";
      await customerUser.save();
      console.log(`✓ Customer user exists: ${customerEmail} (password updated)`);
    }

    // 3. Clear existing catalog data
    console.log("Clearing catalog data (Categories, Products, Orders)...");
    await Category.deleteMany({});
    await Product.deleteMany({});
    await Order.deleteMany({});

    // 4. Create Categories (with image compression)
    console.log("Creating categories...");
    const categoriesData = [
      { name: "Living Room", description: "Designer sofas and accent chairs for a statement living space.", image: furnitureImages.sofas[0], sortOrder: 1 },
      { name: "Bedroom", description: "Premium beds and nightstands for the ultimate sleep experience.", image: furnitureImages.beds[0], sortOrder: 2 },
      { name: "Dining", description: "Elegant dining sets and sideboards for shared moments.", image: furnitureImages.dining[0], sortOrder: 3 },
      { name: "Lighting", description: "Sculptural lighting to illuminate your home with style.", image: furnitureImages.lighting[0], sortOrder: 4 },
      { name: "Decor", description: "Curated objects and wall art for the finishing touch.", image: furnitureImages.decor[0], sortOrder: 5 }
    ];
    
    // Download and compress category images before saving
    console.log("Downloading and compressing category images...");
    for (const category of categoriesData) {
      try {
        const compressedImageBuffer = await compressImageFromUrl(category.image);
        // For now, keep the URL since we don't have a file storage set up in seed
        // In production, this would be uploaded to Cloudinary/storage with compression
        console.log(`✓ Compressed image for category: ${category.name}`);
      } catch (error) {
        console.warn(`Warning: Could not compress image for ${category.name}, using original URL`);
      }
    }
    
    const createdCategories = await Category.create(categoriesData);
    const catMap = {};
    createdCategories.forEach(c => catMap[c.name] = c._id);
    console.log(`✓ Created ${createdCategories.length} categories.`);

    // 5. Create Products (with image compression)
    console.log("Creating premium catalog products...");
    console.log("Downloading and compressing product images (this may take a minute)...");
    
    const productsData = [
      {
        name: "Aura Sheesham Wood 3 Seater Sofa Cum Bed",
        description: "A versatile space-saving solution crafted from premium sheesham wood with intricate hand-carved cane work and luxurious upholstery. This piece seamlessly transitions from a sophisticated sofa to a comfortable bed for guests, featuring superior structural integrity and eco-friendly construction. Includes complementary throw pillows and a protective fabric cover. Perfect for Indian homes seeking traditional craftsmanship with modern functionality.",
        shortDescription: "Space-saving sheesham wood sofa with traditional cane weaving.",
        price: 65999,
        originalPrice: 146999,
        sku: "AUR-SHEESH-3S-001",
        stock: 15,
        status: "active",
        category: catMap["Living Room"],
        images: [{ url: furnitureImages.sofas[0], isPrimary: true, alt: "Aura Sheesham Wood Sofa Cum Bed" }],
        colors: ["Walnut", "Natural", "Honey Brown"],
        materials: ["Sheesham Wood", "Cane Work", "Cotton Upholstery"],
        style: "modern",
        arAvailable: true,
        dimensions: { width: 190, height: 85, depth: 95, unit: "cm" },
        weight: { value: 45, unit: "kg" },
        tags: ["sofa", "bed", "wood", "sheesham", "cane", "convertible", "indian"],
        metaTitle: "Aura Premium Sheesham Wood Sofa Cum Bed - 3 Seater",
        metaDescription: "Premium sheesham wood sofa cum bed with traditional cane work. Space-saving convertible design. Free delivery and installation.",
        rating: { average: 4.8, count: 126 },
        isFeatured: true,
        isNewArrival: false
      },
      {
        name: "Albus 3 Seater Fabric Sofa (Jade Ivory)",
        description: "Experience minimalist luxury with the Albus 3-seater fabric sofa, upholstered in premium cotton in a sophisticated ivory tone. Perfect for modern minimalist living rooms and open spaces, this sofa offers deep seating comfort with a slim profile that doesn't compromise on support. Features solid pine wood frame for durability, stain-resistant fabric treatment, and easy-to-clean covers. Ideal for contemporary interiors where clean lines and comfort meet.",
        shortDescription: "Minimalist cotton sofa in sophisticated ivory tone.",
        price: 37999,
        originalPrice: 63999,
        sku: "ALB-FAB-3S-JADE",
        stock: 22,
        status: "active",
        category: catMap["Living Room"],
        images: [{ url: furnitureImages.sofas[1], isPrimary: true, alt: "Albus 3 Seater Fabric Sofa" }],
        colors: ["Jade Ivory", "Storm Gray", "Soft Beige"],
        materials: ["Cotton Fabric", "Pine Wood Frame", "High-Density Foam"],
        style: "minimal",
        arAvailable: true,
        dimensions: { width: 210, height: 80, depth: 90, unit: "cm" },
        weight: { value: 38, unit: "kg" },
        tags: ["sofa", "fabric", "minimalist", "modern", "living room", "cotton"],
        metaTitle: "Albus 3 Seater Minimalist Fabric Sofa - Jade Ivory",
        metaDescription: "Contemporary fabric sofa with stain-resistant cotton upholstery. Clean lines, deep seating, and premium quality. Perfect for modern homes.",
        rating: { average: 4.7, count: 48 },
        isFeatured: false,
        isNewArrival: true
      },
      {
        name: "Avira Premium Lounge Chair (Salmon Pink)",
        description: "Make a stunning statement with the Avira Premium Lounge Chair, featuring a vibrant salmon pink velvet upholstery that adds personality to any space. This ergonomic accent chair is designed with optimal lumbar support, comfortable armrests, and a sleek metal base finish. Perfect for reading corners, bedroom corners, or as a sophisticated accent piece in your living room. The luxurious velvet texture provides unmatched comfort and visual appeal.",
        shortDescription: "Vibrant salmon pink lounge chair with ergonomic support.",
        price: 14999,
        originalPrice: 31999,
        sku: "AVI-LOUNGE-PINK",
        stock: 35,
        status: "active",
        category: catMap["Living Room"],
        images: [{ url: furnitureImages.chairs[0], isPrimary: true, alt: "Avira Premium Lounge Chair" }],
        colors: ["Salmon Pink", "Emerald Green", "Blush Purple"],
        materials: ["Premium Velvet", "Metal Frame", "High-Density Foam"],
        style: "contemporary",
        arAvailable: false,
        dimensions: { width: 75, height: 105, depth: 80, unit: "cm" },
        weight: { value: 18, unit: "kg" },
        tags: ["chair", "lounge", "accent", "velvet", "pink", "contemporary"],
        metaTitle: "Avira Premium Velvet Lounge Chair - Salmon Pink",
        metaDescription: "Statement lounge chair in premium salmon pink velvet. Ergonomic design with metal frame. Perfect accent piece for any room.",
        rating: { average: 4.9, count: 15 },
        isFeatured: true,
        isNewArrival: true
      },
      {
        name: "Calmora Solid Wood Bed with Upholstered Headboard",
        description: "Experience ultimate comfort with the Calmora Solid Wood Bed, a masterpiece of craftsmanship and design. Handcrafted from premium solid sheesham wood with a rich walnut finish, this bed features an ergonomic upholstered headboard in quality linen fabric. Includes built-in storage compartments under the mattress, robust wooden slats for superior support, and a timeless design that complements any bedroom decor. Available in Queen and King sizes.",
        shortDescription: "Solid wood bed frame with plush headboard and storage.",
        price: 45999,
        originalPrice: 89999,
        sku: "CAL-BED-QUEEN",
        stock: 10,
        status: "active",
        category: catMap["Bedroom"],
        images: [{ url: furnitureImages.beds[0], isPrimary: true, alt: "Calmora Solid Wood Bed" }],
        colors: ["Walnut", "Honey Brown", "Dark Espresso"],
        materials: ["Solid Sheesham Wood", "Linen Upholstery", "Wooden Slats"],
        style: "modern",
        arAvailable: true,
        dimensions: { width: 160, height: 120, depth: 210, unit: "cm" },
        weight: { value: 62, unit: "kg" },
        tags: ["bed", "wood", "bedroom", "queen", "storage", "sheesham"],
        metaTitle: "Calmora Solid Wood Bed with Storage - Queen Size",
        metaDescription: "Premium solid sheesham wood bed with upholstered headboard and storage. Handcrafted quality. Free installation included.",
        rating: { average: 4.6, count: 82 },
        isFeatured: false,
        isNewArrival: false
      },
      {
        name: "Eka Nightstand with Dual Drawers",
        description: "Organize your bedroom with the stylish Eka Nightstand, a sleek minimalist design featuring smooth-gliding dual drawers with soft-close mechanisms. This versatile bedside table includes a hidden cable management port for charging devices and a sturdy engineered wood construction with metal handles. The minimalist aesthetic fits seamlessly with modern bedroom designs while providing ample storage for your bedside essentials.",
        shortDescription: "Minimalist bedside table with ample storage.",
        price: 8499,
        originalPrice: 15999,
        sku: "EKA-NIGHT-2D",
        stock: 50,
        status: "active",
        category: catMap["Bedroom"],
        images: [{ url: furnitureImages.decor[0], isPrimary: true, alt: "Eka Nightstand" }],
        colors: ["Natural Oak", "Charcoal", "Walnut Brown"],
        materials: ["Engineered Wood", "Metal Handles", "Soft-Close Drawer Slides"],
        style: "minimal",
        arAvailable: false,
        dimensions: { width: 45, height: 55, depth: 40, unit: "cm" },
        weight: { value: 12, unit: "kg" },
        tags: ["nightstand", "drawer", "bedroom", "storage", "minimal"],
        metaTitle: "Eka Minimalist Nightstand with Dual Drawers",
        metaDescription: "Space-saving bedroom nightstand with dual drawers and cable management. Modern minimalist design at affordable price.",
        rating: { average: 4.5, count: 34 },
        isFeatured: false,
        isNewArrival: false
      },
      {
        name: "Luxe 6-Seater Marble Dining Table",
        description: "Make every meal a grand affair with this stunning Luxe marble dining table. Featuring a pristine white marble top with natural veining supported by architectural matte black steel legs, this table is a statement piece for any dining space. The marble is heat-resistant, stain-resistant with proper sealing, and incredibly durable. Perfect for family gatherings and entertaining guests with timeless elegance that never goes out of style.",
        shortDescription: "Grand white marble dining table with steel legs.",
        price: 89999,
        originalPrice: 159999,
        sku: "LUX-MARBLE-6S",
        stock: 5,
        status: "active",
        category: catMap["Dining"],
        images: [{ url: furnitureImages.dining[0], isPrimary: true, alt: "Luxe Marble Dining Table" }],
        colors: ["White Marble", "Black Legs"],
        materials: ["Italian White Marble", "Matte Black Steel", "Marble Sealer"],
        style: "modern",
        arAvailable: true,
        dimensions: { width: 200, height: 75, depth: 100, unit: "cm" },
        weight: { value: 85, unit: "kg" },
        tags: ["dining table", "marble", "luxury", "6 seater", "entertainment"],
        metaTitle: "Luxe Italian White Marble Dining Table - 6 Seater",
        metaDescription: "Premium white marble dining table with architectural steel base. Heat and stain resistant. Perfect for elegant dining.",
        rating: { average: 4.9, count: 12 },
        isFeatured: true,
        isNewArrival: false
      },
      {
        name: "Hygge Upholstered Dining Chair (Set of 2)",
        description: "Experience Scandinavian comfort with this set of two Hygge dining chairs, expertly designed with curved backrests that support natural spine alignment. Upholstered in spill-resistant performance fabric, these chairs feature tapered wooden legs in natural ash wood and provide exceptional durability for family dining. The soft padding and ergonomic design make dining a pleasure, while the easy-to-clean fabric is perfect for households with children.",
        shortDescription: "Comfortable Scandi-style dining chairs, spill-resistant.",
        price: 12999,
        originalPrice: 24999,
        sku: "HYG-CHAIR-SET2",
        stock: 40,
        status: "active",
        category: catMap["Dining"],
        images: [{ url: furnitureImages.chairs[1], isPrimary: true, alt: "Hygge Dining Chairs" }],
        colors: ["Mist Gray", "Sand Beige", "Charcoal"],
        materials: ["Performance Fabric", "Ash Wood Legs", "High-Density Foam Padding"],
        style: "scandinavian",
        arAvailable: false,
        dimensions: { width: 50, height: 85, depth: 55, unit: "cm" },
        weight: { value: 28, unit: "kg" },
        tags: ["dining chair", "set", "scandinavian", "upholstered", "performance fabric"],
        metaTitle: "Hygge Scandinavian Dining Chairs - Set of 2",
        metaDescription: "Comfortable upholstered dining chairs with spill-resistant fabric. Set of 2. Perfect for modern and traditional dining rooms.",
        rating: { average: 4.8, count: 56 },
        isFeatured: false,
        isNewArrival: false
      },
      {
        name: "Solis Industrial Pendant Chandelier",
        description: "Transform your kitchen or dining area with the striking Solis Industrial Pendant Chandelier, an architectural masterpiece featuring raw metal finishes and exposed Edison-style bulbs. Crafted from wrought iron with a matte black finish and vintage-inspired design, this chandelier creates ambient lighting with industrial character. Perfect for kitchens, dining areas, and contemporary loft spaces. Each fixture includes adjustable wire length for custom installation.",
        shortDescription: "Raw metal industrial chandelier for kitchen or dining.",
        price: 7499,
        originalPrice: 14999,
        sku: "SOL-PEND-CHANDI",
        stock: 25,
        status: "active",
        category: catMap["Lighting"],
        images: [{ url: furnitureImages.lighting[0], isPrimary: true, alt: "Solis Industrial Pendant" }],
        colors: ["Matte Black", "Rustic Copper"],
        materials: ["Wrought Iron", "Glass Shades", "Vintage Edison Bulbs"],
        style: "industrial",
        arAvailable: false,
        dimensions: { width: 60, height: 80, depth: 60, unit: "cm" },
        weight: { value: 8, unit: "kg" },
        tags: ["chandelier", "pendant", "industrial", "lighting", "kitchen"],
        metaTitle: "Solis Industrial Pendant Chandelier - Matte Black",
        metaDescription: "Raw metal industrial lighting fixture with vintage Edison bulbs. Perfect for contemporary kitchens and lofts.",
        rating: { average: 4.7, count: 28 },
        isFeatured: false,
        isNewArrival: false
      },
      {
        name: "Nova Adjustable Floor Lamp",
        description: "Illuminate your reading corner or home office with the elegant Nova Adjustable Floor Lamp. Featuring a sleek brushed gold finish and an adjustable boom arm, this versatile task light provides directional illumination exactly where you need it. The marble base provides stability and aesthetic appeal, while the adjustable arm allows for optimal light placement. Perfect for focused work, reading, or creating ambient lighting in any room.",
        shortDescription: "Elegant gold floor lamp with adjustable task lighting.",
        price: 6499,
        originalPrice: 12999,
        sku: "NOV-FLOOR-GOLD",
        stock: 18,
        status: "active",
        category: catMap["Lighting"],
        images: [{ url: furnitureImages.lighting[1], isPrimary: true, alt: "Nova Floor Lamp" }],
        colors: ["Brushed Gold", "Matte Black", "Chrome"],
        materials: ["Brass", "Marble Base", "Fabric Shade"],
        style: "modern",
        arAvailable: false,
        dimensions: { width: 50, height: 160, depth: 50, unit: "cm" },
        weight: { value: 6, unit: "kg" },
        tags: ["floor lamp", "adjustable", "task lighting", "home office", "reading"],
        metaTitle: "Nova Adjustable Floor Lamp - Brushed Gold",
        metaDescription: "Modern adjustable task lamp with marble base. Perfect for home office and reading corners. Dimmable and adjustable.",
        rating: { average: 4.9, count: 42 },
        isFeatured: false,
        isNewArrival: true
      },
      {
        name: "Zen Handcrafted Ceramic Vases (Set of 3)",
        description: "Add organic beauty to your home with this curated set of three Zen handcrafted ceramic vases in varying sizes. Each piece features a unique reactive glaze that creates one-of-a-kind patterns, making every set truly unique. Hand-thrown by skilled artisans, these vases celebrate natural imperfections and showcase the artistry of traditional pottery. Perfect for displaying fresh flowers, branches, or as standalone decorative pieces.",
        shortDescription: "Organic handcrafted ceramic vases with reactive glaze.",
        price: 3499,
        originalPrice: 6999,
        sku: "ZEN-VASE-SET3",
        stock: 60,
        status: "active",
        category: catMap["Decor"],
        images: [{ url: furnitureImages.decor[1], isPrimary: true, alt: "Zen Ceramic Vases" }],
        colors: ["Terracotta", "Stone Gray", "Sage Green"],
        materials: ["Hand-Thrown Ceramic", "Reactive Glaze", "Natural Clay"],
        style: "bohemian",
        arAvailable: false,
        dimensions: { width: 30, height: 40, depth: 30, unit: "cm" },
        weight: { value: 4, unit: "kg" },
        tags: ["vases", "ceramic", "handcrafted", "decor", "bohemian", "set"],
        metaTitle: "Zen Handcrafted Ceramic Vases - Set of 3",
        metaDescription: "Artisan-made ceramic vases with unique reactive glaze. Set of 3 in varying sizes. Perfect home decor accent.",
        rating: { average: 4.6, count: 94 },
        isFeatured: false,
        isNewArrival: false
      },
      {
        name: "Eclipse Round Brass Wall Mirror",
        description: "Create an illusion of space and light with the elegant Eclipse Round Brass Wall Mirror. This large circular mirror features a sophisticated hand-polished brass frame that adds warmth and elegance to any hallway, bedroom, or living space. The thin frame design emphasizes the mirror's simplicity while the high-quality reflective glass ensures clarity. Perfect for modern and minimalist interiors seeking a touch of vintage charm.",
        shortDescription: "Large round wall mirror with hand-polished brass frame.",
        price: 11999,
        originalPrice: 19999,
        sku: "ECL-MIRROR-BRASS",
        stock: 12,
        status: "active",
        category: catMap["Decor"],
        images: [{ url: furnitureImages.decor[2], isPrimary: true, alt: "Eclipse Round Mirror" }],
        colors: ["Polished Brass", "Antique Brass", "Champagne Gold"],
        materials: ["Hand-Polished Brass", "High-Quality Glass", "Wooden Backing"],
        style: "minimal",
        arAvailable: false,
        dimensions: { width: 80, height: 80, depth: 5, unit: "cm" },
        weight: { value: 5, unit: "kg" },
        tags: ["mirror", "wall", "brass", "round", "decor", "reflection"],
        metaTitle: "Eclipse Round Brass Wall Mirror - Large",
        metaDescription: "Stylish round wall mirror with hand-polished brass frame. Perfect for adding light and elegance to any room.",
        rating: { average: 4.8, count: 37 },
        isFeatured: false,
        isNewArrival: false
      }
    ];

    // Compress product images before creating them
    console.log("Compressing product images...");
    for (const product of productsData) {
      if (product.images && product.images.length > 0) {
        for (const image of product.images) {
          try {
            const compressedImageBuffer = await compressImageFromUrl(image.url);
            // In production, upload compressed buffer to Cloudinary
            // For seed, we keep the URL but log compression benefit
            console.log(`✓ Compressed image for product: ${product.name}`);
          } catch (error) {
            console.warn(`Warning: Could not compress image for ${product.name}, using original URL`);
          }
        }
      }
    }

    const createdProducts = await Product.create(productsData);
    console.log(`✓ Created ${createdProducts.length} premium products.`);

    // 6. Create historical simulated orders
    console.log("Generating simulated historical order records...");
    const orders = [];
    const numOrders = 20;
    const now = new Date();

    for (let i = 0; i < numOrders; i++) {
      const daysAgo = Math.floor(Math.random() * 60);
      const date = new Date(now);
      date.setDate(date.getDate() - daysAgo);

      const numItems = Math.floor(Math.random() * 3) + 1;
      const orderItems = [];
      let subtotal = 0;

      for (let j = 0; j < numItems; j++) {
        const prod = createdProducts[Math.floor(Math.random() * createdProducts.length)];
        const qty = Math.floor(Math.random() * 2) + 1;
        orderItems.push({
          product: prod._id,
          name: prod.name,
          price: prod.price,
          quantity: qty,
          image: prod.images[0].url
        });
        subtotal += prod.price * qty;
      }

      orders.push({
        user: customerUser._id,
        guestInfo: {
          email: customerUser.email,
          firstName: customerUser.firstName,
          lastName: customerUser.lastName,
          phone: customerUser.phone || "9800000000"
        },
        items: orderItems,
        shippingAddress: {
          fullName: `${customerUser.firstName} ${customerUser.lastName}`,
          phone: customerUser.phone || "9800000000",
          addressLine1: "Baneshwor-10",
          city: "Kathmandu",
          postalCode: "44600",
          country: "Nepal"
        },
        subtotal,
        total: subtotal,
        paymentMethod: i % 4 === 0 ? "esewa" : "cod",
        paymentStatus: i % 4 === 0 ? "paid" : "pending",
        orderStatus: i % 10 === 0 ? "delivered" : "processing",
        createdAt: date,
        orderedAt: date,
        isGuestOrder: false
      });
    }

    await Order.create(orders);
    console.log(`✓ Created ${orders.length} simulated orders.`);
    console.log("✓ Seeding finished successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Seeding operation failed:", error);
    process.exit(1);
  }
};

runSeeder();
