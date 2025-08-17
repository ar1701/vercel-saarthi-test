const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const express = require("express");
const app = express();

// Set initial database status to false - will be set to true when connected
app.set("dbStatus", false);

// Load environment variables
const ENV = {
  DB_URL: process.env.ATLASDB_URL || process.env.MONGODB_URI,
  SECRET: process.env.SECRET || "development_secret_key",
  GEMINI_KEY: process.env.GEMINI_API_KEY,
  NODE_ENV: process.env.NODE_ENV || "development",
  IS_VERCEL: !!process.env.VERCEL,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUD_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUD_SECRET_KEY,
};

// Log environment status but not sensitive values
console.log(`Environment: ${ENV.NODE_ENV}`);
console.log(`Running on Vercel: ${ENV.IS_VERCEL}`);
console.log(`Database URL defined: ${!!ENV.DB_URL}`);
console.log(`Gemini API Key defined: ${!!ENV.GEMINI_KEY}`);

const mongoose = require("mongoose");
const axios = require("axios");
const fs = require("fs");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

// Configure Cloudinary
if (
  ENV.CLOUDINARY_CLOUD_NAME &&
  ENV.CLOUDINARY_API_KEY &&
  ENV.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
    api_key: ENV.CLOUDINARY_API_KEY,
    api_secret: ENV.CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log("Cloudinary configured successfully");
} else {
  console.warn("Cloudinary credentials missing - file uploads may not work");
}
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize services based on available environment variables
const dbUrl = ENV.DB_URL;
const genAI = ENV.GEMINI_KEY ? new GoogleGenerativeAI(ENV.GEMINI_KEY) : null;

// Conditionally require models to handle missing database
let User, Profile, QuizResult;
try {
  User = require("../model/user.js");
  Profile = require("../model/profile.js");
  QuizResult = require("../model/quiz.js");
} catch (err) {
  console.error("Error loading models:", err.message);
}

const session = require("express-session");
const MongoStore = require("connect-mongo");
const LocalStrategy = require("passport-local");
const passport = require("passport");
const flash = require("connect-flash");
const middleware = require("../middleware.js");
const isLoggedIn = middleware.isLoggedIn;
// const { storage } = require("./cloudConfig.js");

async function extractImage(url) {
  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "arraybuffer",
    });
    return response.data;
  } catch (error) {
    console.error("Error extracting image:", error);
    throw error;
  }
}

// Use different storage strategies based on environment
let upload;
if (ENV.IS_VERCEL) {
  // Use memory storage on Vercel (read-only filesystem)
  console.log("Using memory storage for file uploads on Vercel");
  upload = multer({ storage: multer.memoryStorage() });
} else {
  // Create uploads directory if it doesn't exist for local development
  const uploadsDir = path.join(__dirname, "../uploads");
  if (!fs.existsSync(uploadsDir)) {
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log("Created uploads directory");
    } catch (err) {
      console.error("Failed to create uploads directory:", err);
    }
  }

  // Use disk storage for local development
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
      // Generate unique filename to prevent overwrites
      const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${
        file.originalname
      }`;
      cb(null, uniqueName);
    },
  });
  upload = multer({ storage });
  console.log("Using disk storage for file uploads in development");
}

// Check if database URL is available
if (!dbUrl) {
  console.error(
    "WARNING: Database URL is not defined! Check your environment variables."
  );
}

// Create MongoStore with better error handling
let store;
try {
  store = MongoStore.create({
    mongoUrl: dbUrl,
    crypto: {
      secret: process.env.SECRET || "fallback_secret_for_development",
    },
    touchAfter: 24 * 60 * 60,
    autoRemove: "native",
    ttl: 7 * 24 * 60 * 60, // 1 week
  });

  store.on("error", (error) => {
    console.error("MongoStore Error:", error);
  });
} catch (err) {
  console.error("Failed to create MongoStore:", err);
  // Fallback to memory store if in development to prevent crashes
  if (process.env.NODE_ENV !== "production") {
    console.log("Using fallback memory store for session");
    // No store means it will use the default MemoryStore
    store = undefined;
  } else {
    throw err; // In production, we want to know if this fails
  }
}

const sessionOptions = {
  secret: process.env.SECRET || "fallback_secret_for_development",
  resave: false,
  saveUninitialized: true, // Changed to true to ensure session is created
  cookie: {
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // Only use secure cookies in production with HTTPS
    secure: false,
    sameSite: "lax", // More permissive for local development
  },
};

// Only add store to session options if it was successfully created
if (store) {
  sessionOptions.store = store;
  console.log("Using MongoDB store for sessions");
} else {
  console.log("Using in-memory session store");
}

console.log(
  "Session options:",
  JSON.stringify({
    secret: sessionOptions.secret ? "***" : "not set",
    resave: sessionOptions.resave,
    saveUninitialized: sessionOptions.saveUninitialized,
    cookieSecure: sessionOptions.cookie.secure,
    cookieSameSite: sessionOptions.cookie.sameSite,
  })
);

app.use(session(sessionOptions));
app.use(flash());

// Body parsing middleware - use only one set
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));

// Serve static files from various paths for maximum compatibility
// This makes assets available at multiple URL patterns
app.use(express.static(path.join(__dirname, "../public"))); // Serve at root path (/)
app.use("/public", express.static(path.join(__dirname, "../public"))); // Also serve at /public
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Special handling for common asset directories
app.use("/css", express.static(path.join(__dirname, "../public/css")));
app.use("/js", express.static(path.join(__dirname, "../public/js")));
app.use("/img", express.static(path.join(__dirname, "../public/img")));
app.use("/images", express.static(path.join(__dirname, "../public/img")));

app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);

// Connect to MongoDB with improved error handling
async function connectToDatabase() {
  try {
    if (!dbUrl) {
      console.error(
        "MongoDB connection URL is not defined in environment variables"
      );
      console.error(
        "Available environment variables:",
        Object.keys(process.env).join(", ")
      );
      throw new Error("MongoDB connection URL is not defined");
    }

    console.log("Connecting to MongoDB...");
    console.log("Database URL defined:", !!dbUrl);
    // Don't log the full URL for security, but log a sanitized version
    console.log(
      "Database URL pattern:",
      dbUrl.replace(/\/\/([^:]+):([^@]+)@/, "//USERNAME:PASSWORD@")
    );

    const connectOptions = {
      // Add mongoose connection options for better reliability
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };

    await mongoose.connect(dbUrl, connectOptions);
    console.log("✅ MongoDB connection succeeded");

    // Set database status to connected
    app.set("dbStatus", true);

    // Log database information
    const dbName = mongoose.connection.name;
    const collections = await mongoose.connection.db
      .listCollections()
      .toArray();
    console.log(`Connected to database: ${dbName}`);
    console.log(
      `Available collections: ${collections.map((c) => c.name).join(", ")}`
    );

    return true;
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    if (err.name === "MongoServerSelectionError") {
      console.error(
        "This may be due to network issues, firewall settings, or incorrect connection string"
      );
    }

    // Set database status to disconnected
    app.set("dbStatus", false);

    // In development, we can continue without a database for some testing
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "⚠️  Running without database connection in development mode"
      );
      console.log(
        "You can use the /_dev-login route for testing without a database"
      );
      return false;
    }

    // In production, try again after a delay
    if (process.env.VERCEL) {
      console.log("Will retry database connection in 5 seconds...");
      setTimeout(() => connectToDatabase(), 5000);
    }

    return false;
  }
}

// Initialize database connection
connectToDatabase();

app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));

passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  res.locals.currUser = req.user;
  res.locals.currentPage = req.path.split("/")[1] || "home";

  // Debug middleware to track session and auth state
  const url = req.originalUrl;
  // Only log for important routes to avoid excessive logging
  if (url === "/login" || url === "/index" || url === "/signup") {
    console.log(`[${new Date().toISOString()}] Route: ${url}`);
    console.log("- Session ID:", req.sessionID);
    console.log("- Authenticated:", req.isAuthenticated());
    console.log("- User:", req.user ? req.user.username : "none");
  }
  next();
});

// Only start the server when not running on Vercel
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log("✅ Server listening on port " + port);

    if (!ENV.DB_URL) {
      console.log(
        "⚠️  WARNING: Database URL is not defined! Check your environment variables."
      );
      console.log(
        "🔍 Access the debug page at http://localhost:" +
          port +
          "/_debug for more information"
      );
    } else if (!mongoose.connection.readyState) {
      console.log(
        "⚠️  WARNING: Database connection failed. Check your MongoDB connection."
      );
      console.log(
        "🔍 Access the debug page at http://localhost:" +
          port +
          "/_debug for more information"
      );
    } else {
      console.log("✅ Database connected successfully");
    }

    console.log(
      `📊 Health check available at http://localhost:${port}/_healthcheck`
    );
  });
}

// For Vercel serverless functions
// Handle direct invocation from Vercel
if (process.env.VERCEL) {
  console.log("Running in Vercel serverless environment");
}

// Export for Vercel serverless
module.exports = app;

// Routes
app.get("/", (req, res) => {
  res.redirect("/main");
});

// Health check route for debugging Vercel deployment
app.get("/_healthcheck", (req, res) => {
  res.json({
    status: "ok",
    environment: ENV.NODE_ENV,
    isVercel: ENV.IS_VERCEL,
    databaseConnected: !!mongoose.connection.readyState,
    databaseUrlDefined: !!ENV.DB_URL,
    geminiApiKeyDefined: !!ENV.GEMINI_KEY,
    secretKeyDefined: !!ENV.SECRET,
    cloudinaryConfigured: !!(
      ENV.CLOUDINARY_CLOUD_NAME &&
      ENV.CLOUDINARY_API_KEY &&
      ENV.CLOUDINARY_API_SECRET
    ),
    fileStorageType: ENV.IS_VERCEL ? "memory+cloudinary" : "disk",
    timestamp: new Date().toISOString(),
    serverVersion: "1.0.0",
  });
});

// Auth status check for debugging
app.get("/_auth-check", (req, res) => {
  res.json({
    isAuthenticated: req.isAuthenticated(),
    hasSession: !!req.session,
    sessionID: req.sessionID,
    user: req.user
      ? {
          username: req.user.username,
          id: req.user._id,
        }
      : null,
    cookies: req.headers.cookie,
    dbStatus: app.get("dbStatus"),
    mongoConnection: mongoose.connection.readyState,
  });
});

// Test login route for development only
if (process.env.NODE_ENV !== "production") {
  app.get("/_dev-login", (req, res) => {
    // Create a fake session for development testing
    if (!req.session.user) {
      req.session.user = { username: "dev-user" };
    }

    // Mock the req.isAuthenticated() method for passport
    req.isAuthenticated = function () {
      return true;
    };

    // Set a flash message
    req.flash("success", "Development login successful!");

    // Redirect to the index page
    res.redirect("/index");
  });
}

app.get("/index", isLoggedIn, (req, res) => {
  res.render("index.ejs", { currentPage: "home" });
});

app.get("/about", isLoggedIn, (req, res) => {
  res.render("about.ejs", { currentPage: "about" });
});

app.get("/contact", isLoggedIn, (req, res) => {
  res.render("contact.ejs", { currentPage: "contact" });
});

app.get("/team", isLoggedIn, (req, res) => {
  res.render("team.ejs", { currentPage: "team" });
});

app.get("/testimonial", isLoggedIn, (req, res) => {
  res.render("testimonial.ejs", { currentPage: "testimonial" });
});

app.get("/courses", isLoggedIn, (req, res) => {
  res.render("courses.ejs", { currentPage: "courses" });
});

app.get("/form", isLoggedIn, (req, res) => {
  res.render("form.ejs", { currentPage: "form" });
});

app.get("/search", isLoggedIn, (req, res) => {
  res.render("search.ejs", { currentPage: "search" });
});

app.get("/syllabus", isLoggedIn, (req, res) => {
  res.render("syllabus.ejs", { currentPage: "syllabus" });
});

app.get("/ask", isLoggedIn, (req, res) => {
  res.render("ask.ejs", { currentPage: "ask" });
});

app.get("/chat", isLoggedIn, (req, res) => {
  res.render("chat.ejs", { currentPage: "chat" });
});

app.get("/main", (req, res) => {
  res.render("main.ejs");
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.get("/signup", (req, res) => {
  res.render("signup.ejs");
});

app.get("/grading", isLoggedIn, (req, res) => {
  res.render("grading.ejs", { currentPage: "grading" });
});

app.get("/essay-writer", isLoggedIn, (req, res) => {
  res.render("essay-writer.ejs", { currentPage: "essay-writer" });
});

app.get("/code-explainer", isLoggedIn, (req, res) => {
  res.render("code-explainer.ejs", { currentPage: "code-explainer" });
});

app.get("/study-planner", isLoggedIn, (req, res) => {
  res.render("study-planner.ejs", { currentPage: "study-planner" });
});

app.get("/flashcard-generator", isLoggedIn, (req, res) => {
  res.render("flashcard-generator.ejs", { currentPage: "flashcard-generator" });
});

app.get("/quiz-generator", isLoggedIn, (req, res) => {
  res.render("quiz-generator.ejs", { currentPage: "quiz-generator" });
});

// Policy Pages
app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy.ejs", { currentPage: "privacy-policy" });
});

app.get("/terms-of-service", (req, res) => {
  res.render("terms-of-service.ejs", { currentPage: "terms-of-service" });
});

app.get("/cookie-policy", (req, res) => {
  res.render("cookie-policy.ejs", { currentPage: "cookie-policy" });
});

app.post(
  "/login",
  (req, res, next) => {
    console.log("Login attempt for username:", req.body.username);
    console.log("Database status:", app.get("dbStatus"));
    console.log("MongoDB connection state:", mongoose.connection.readyState);
    next();
  },
  passport.authenticate("local", {
    failureRedirect: "/login?error=Invalid username or password",
    failureFlash: true,
  }),
  async (req, res) => {
    console.log("Authentication successful for:", req.body.username);
    let { username } = req.body;
    req.session.user = { username };
    req.flash("success", "Welcome to Saarthi!");
    console.log("Session saved, redirecting to /index");
    res.redirect("/index");
  }
);

app.get("/signup", (req, res) => {
  res.render("signup.ejs");
});

app.post("/signup", async (req, res) => {
  try {
    let { username, email, phone, password } = req.body;
    req.session.user = { username, email, phone };
    const newUser = new User({ username, email, phone });

    await User.register(newUser, password);

    const newProfile = new Profile({
      user: newUser._id,
      gender: "",
      bio: "",
    });
    await newProfile.save();
    res.redirect("/login");
  } catch (e) {
    res.redirect("/signup");
  }
});

app.post("/syllabus", isLoggedIn, async (req, res) => {
  try {
    let { std, subject } = req.body;
    let result = await syllabusGen(std, subject);
    res.json({ result: result });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        "I apologize, but I'm having trouble generating the syllabus right now. Please try again in a moment.",
    });
  }
});

// New AI-powered features
app.post("/essay-writer", isLoggedIn, async (req, res) => {
  try {
    const { topic, type, length } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Write a ${type} essay on "${topic}" with approximately ${length} words.

Guidelines:
- Use clear, engaging language
- Include an introduction, body paragraphs, and conclusion
- Provide relevant examples and evidence
- Use proper essay structure and formatting
- Make it educational and informative
- Use markdown formatting for better readability

Please write a well-structured essay:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    res.json({ result: text });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        "I apologize, but I'm having trouble generating the essay right now. Please try again in a moment.",
    });
  }
});

app.post("/code-explainer", isLoggedIn, async (req, res) => {
  try {
    const { code, language } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Explain this ${language} code in detail:

\`\`\`${language}
${code}
\`\`\`

Please provide:
1. A clear explanation of what the code does
2. Line-by-line breakdown of important parts
3. Key concepts and programming principles used
4. Potential improvements or optimizations
5. Common use cases for this type of code

Use markdown formatting for better readability.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    res.json({ result: text });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        "I apologize, but I'm having trouble explaining the code right now. Please try again in a moment.",
    });
  }
});

app.post("/study-planner", isLoggedIn, async (req, res) => {
  try {
    const { subjects, hours, days, goals } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Create a personalized study plan for a student with the following requirements:

Subjects: ${subjects}
Available study hours per day: ${hours}
Study days per week: ${days}
Learning goals: ${goals}

Please provide:
1. A weekly study schedule
2. Time allocation for each subject
3. Study techniques and strategies
4. Break and rest periods
5. Progress tracking methods
6. Tips for maintaining motivation

Use markdown formatting and make it practical and achievable.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    res.json({ result: text });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        "I apologize, but I'm having trouble creating the study plan right now. Please try again in a moment.",
    });
  }
});

app.post("/flashcard-generator", isLoggedIn, async (req, res) => {
  try {
    const { topic, subject, count } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Generate ${count} flashcards for ${subject} on the topic: "${topic}"

Format each flashcard as:
**Question:** [Clear, concise question]
**Answer:** [Detailed, educational answer]

Guidelines:
- Questions should test understanding, not just memorization
- Answers should be comprehensive but concise
- Include a mix of difficulty levels
- Cover key concepts and important details
- Make them engaging and educational

Use markdown formatting for better readability.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    res.json({ result: text });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error:
        "I apologize, but I'm having trouble generating flashcards right now. Please try again in a moment.",
    });
  }
});

// Quiz Generator - Generate Quiz Questions
app.post("/quiz-generator", isLoggedIn, async (req, res) => {
  try {
    const { topic, difficulty, type, count } = req.body;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const enhancedPrompt = `Generate a ${difficulty} level quiz on the topic: "${topic}" with exactly ${count} ${type} questions.

IMPORTANT: You must respond with ONLY valid JSON in this exact format:
{
  "questions": [
    {
      "questionNumber": 1,
      "question": "What is the capital of France?",
      "options": ["A. London", "B. Paris", "C. Berlin", "D. Madrid"],
      "correctAnswer": "B",
      "explanation": "Paris is the capital and largest city of France."
    }
  ]
}

Requirements:
- For MCQ questions: Always provide exactly 4 options labeled A, B, C, D
- For Subjective questions: Use the options field for key points and explanation for detailed answer
- Make questions appropriate for ${difficulty} difficulty level
- Include clear, educational explanations
- Ensure questions test understanding, not just memorization
- Do not include any text before or after the JSON object
- The response must be valid JSON that can be parsed directly

Generate exactly ${count} questions for the topic: ${topic}`;

    const result = await model.generateContent(enhancedPrompt);
    const response = await result.response;
    const text = response.text();

    // Try to parse JSON, if it fails, try to extract JSON from the response
    try {
      const quizData = JSON.parse(text);
      res.json({ quiz: quizData, topic, difficulty, type, count });
    } catch (parseError) {
      // Try to extract JSON from the response if it contains extra text
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const extractedJson = JSON.parse(jsonMatch[0]);
          res.json({ quiz: extractedJson, topic, difficulty, type, count });
        } else {
          throw new Error("No JSON found in response");
        }
      } catch (extractError) {
        res.status(500).json({
          error:
            "Failed to generate structured quiz. Please try again with a different topic.",
        });
      }
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Failed to generate quiz. Please try again.",
    });
  }
});

// Submit Quiz Answers
app.post("/submit-quiz", isLoggedIn, async (req, res) => {
  try {
    const { topic, difficulty, type, count, answers, timeTaken } = req.body;
    const userId = req.user._id;

    // Calculate score
    let correctAnswers = 0;
    const userAnswers = [];

    for (let i = 0; i < answers.length; i++) {
      const userAnswer = answers[i].userAnswer;
      const correctAnswer = answers[i].correctAnswer;
      const isCorrect = userAnswer === correctAnswer;

      if (isCorrect) correctAnswers++;

      userAnswers.push({
        questionNumber: i + 1,
        userAnswer,
        correctAnswer,
        isCorrect,
      });
    }

    const score = Math.round((correctAnswers / answers.length) * 100);

    // Save to database
    const quizResult = new QuizResult({
      user: userId,
      topic,
      difficulty,
      questionType: type,
      totalQuestions: parseInt(count),
      correctAnswers,
      score,
      userAnswers,
      timeTaken: parseInt(timeTaken),
    });

    await quizResult.save();

    res.json({
      success: true,
      score,
      correctAnswers,
      totalQuestions: answers.length,
      userAnswers,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Failed to submit quiz. Please try again.",
    });
  }
});

// Get Quiz History
app.get("/quiz-history", isLoggedIn, async (req, res) => {
  try {
    const quizResults = await QuizResult.find({ user: req.user._id })
      .sort({ completedAt: -1 })
      .limit(10);

    res.json({ quizResults });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Failed to fetch quiz history.",
    });
  }
});

app.post("/ask", isLoggedIn, async (req, res) => {
  try {
    let { question } = req.body;
    let result = await textQuery(question);
    res.json({ result: result });
  } catch (error) {
    console.error("Error in /ask:", error);

    // Check if it's a Gemini API overload error
    if (error.status === 503 || error.message?.includes("overloaded")) {
      return res.status(503).json({
        error:
          "The AI service is currently experiencing high traffic. Please try again in a few minutes.",
      });
    }

    res.status(500).json({
      error:
        "I apologize, but I'm having trouble processing your request right now. Please try again in a moment.",
    });
  }
});

app.post("/chat", isLoggedIn, async (req, res) => {
  try {
    const userInput = req.body.message;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Enhanced prompt for better structured responses
    const enhancedPrompt = `You are an AI educational assistant for Saarthi, an innovative learning platform. 

Please provide clear, structured, and educational responses to the user's question. Follow these guidelines:

1. **Structure your response** with clear headings using markdown (## for main sections, ### for subsections)
2. **Use bullet points** for lists and key concepts
3. **Include examples** where helpful
4. **Keep explanations** concise but comprehensive
5. **Use bold text** for important terms and concepts
6. **Format code** using \`code blocks\` when applicable
7. **Be encouraging** and supportive in your tone
8. **Adapt to the user's level** - assume they are a student seeking to learn

User Question: ${userInput}

Please provide a well-structured educational response:`;

    const result = await model.generateContent(enhancedPrompt);
    const response = await result.response;
    const text = response.text();

    res.json({ message: text });
  } catch (error) {
    console.error("Error in /chat:", error);

    // Check if it's a Gemini API overload error
    if (error.status === 503 || error.message?.includes("overloaded")) {
      return res.status(503).json({
        message:
          "The AI service is currently experiencing high traffic. Please try again in a few minutes.",
      });
    }

    res.status(500).json({
      message:
        "I apologize, but I'm having trouble processing your request right now. Please try again in a moment.",
    });
  }
});

app.post("/form", isLoggedIn, upload.single("image"), async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    console.log("File received:", req.file.originalname || "unnamed file");

    // Initialize variables for image processing
    let base64Data;
    let cloudinaryUrl;

    if (ENV.IS_VERCEL) {
      try {
        // On Vercel: Upload to Cloudinary from memory buffer
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "saarthi_problems" },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );

          uploadStream.end(req.file.buffer);
        });

        cloudinaryUrl = result.secure_url;
        console.log("Image uploaded to Cloudinary:", cloudinaryUrl);

        // Download the image from Cloudinary to get base64
        const imageResponse = await axios.get(cloudinaryUrl, {
          responseType: "arraybuffer",
        });
        base64Data = Buffer.from(imageResponse.data).toString("base64");
      } catch (cloudinaryError) {
        console.error("Cloudinary upload error:", cloudinaryError);
        return res.status(500).json({ error: "Failed to upload image" });
      }
    } else {
      // In local development: Read from disk
      base64Data = fs.readFileSync(req.file.path).toString("base64");
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Enhanced prompt for image analysis
    const enhancedPrompt = `You are an AI educational assistant analyzing an image that contains a problem or question. 

Please provide a comprehensive, well-structured solution following these guidelines:

1. **Start with a clear overview** of what you see in the image
2. **Break down the problem** into understandable steps
3. **Provide the solution** with detailed explanations
4. **Use markdown formatting** for better structure:
   - Use ## for main sections
   - Use ### for subsections
   - Use bullet points for lists
   - Use **bold** for important terms
   - Use \`code\` for mathematical expressions or code
5. **Include relevant concepts** and explanations
6. **Be encouraging** and educational in your tone
7. **If it's a math problem**, show step-by-step calculations
8. **If it's a conceptual question**, provide clear explanations with examples

Please analyze the image and provide a structured educational response:`;

    const imageParts = [
      {
        inlineData: {
          data: base64Data,
          mimeType: "image/jpeg",
        },
      },
    ];

    const result = await model.generateContent([enhancedPrompt, ...imageParts]);
    const response = await result.response;
    const text = response.text();

    // Clean up uploaded file if in local development
    if (!ENV.IS_VERCEL && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({ result: text });
  } catch (error) {
    console.error("Error in /form:", error);

    // Clean up uploaded file if in local development
    if (
      !ENV.IS_VERCEL &&
      req.file &&
      req.file.path &&
      fs.existsSync(req.file.path)
    ) {
      fs.unlinkSync(req.file.path);
    }

    // Check if it's a Gemini API overload error
    if (error.status === 503 || error.message?.includes("overloaded")) {
      return res.status(503).json({
        error:
          "The AI service is currently experiencing high traffic. Please try again in a few minutes.",
      });
    }

    // Check if it's a file system error
    if (error.code === "EROFS" || error.code === "ENOENT") {
      return res.status(500).json({
        error: "File system error. We're using Cloudinary for uploads now.",
      });
    }

    // Generic error
    res.status(500).json({
      error: "An error occurred while processing your image. Please try again.",
    });
  }
});

// Set up a route for logging out
app.get("/logout", (req, res, next) => {
  req.logout(function (err) {
    if (err) {
      console.error("Error logging out:", err);
      return next(err); // Forward the error to the error handler
    }
    res.redirect("/main"); // Only one response
  });
});

// Error information route
app.get("/_debug", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Saarthi - Environment Debug</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; }
          h1 { color: #333; }
          .box { border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; border-radius: 5px; }
          .error { color: #d9534f; }
          .success { color: #5cb85c; }
          code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; }
          pre { background: #f5f5f5; padding: 15px; overflow-x: auto; }
          img { max-width: 100%; border: 1px solid #ddd; margin: 10px 0; }
        </style>
      </head>
      <body>
        <h1>Saarthi Environment Status</h1>
        
        <div class="box">
          <h2>Environment Variables</h2>
          <p>Database URL: <span class="${ENV.DB_URL ? "success" : "error"}">${
    ENV.DB_URL ? "Defined" : "Missing"
  }</span></p>
          <p>Secret Key: <span class="${ENV.SECRET ? "success" : "error"}">${
    ENV.SECRET ? "Defined" : "Missing"
  }</span></p>
          <p>Gemini API Key: <span class="${
            ENV.GEMINI_KEY ? "success" : "error"
          }">${ENV.GEMINI_KEY ? "Defined" : "Missing"}</span></p>
          <p>Cloudinary Name: <span class="${
            ENV.CLOUDINARY_CLOUD_NAME ? "success" : "error"
          }">${ENV.CLOUDINARY_CLOUD_NAME ? "Defined" : "Missing"}</span></p>
          <p>Cloudinary API Key: <span class="${
            ENV.CLOUDINARY_API_KEY ? "success" : "error"
          }">${ENV.CLOUDINARY_API_KEY ? "Defined" : "Missing"}</span></p>
          <p>Cloudinary Secret: <span class="${
            ENV.CLOUDINARY_API_SECRET ? "success" : "error"
          }">${ENV.CLOUDINARY_API_SECRET ? "Defined" : "Missing"}</span></p>
          <p>Node Environment: ${ENV.NODE_ENV}</p>
          <p>Running on Vercel: ${ENV.IS_VERCEL ? "Yes" : "No"}</p>
          <p>File Storage: ${
            ENV.IS_VERCEL ? "Memory + Cloudinary" : "Local Disk"
          }</p>
        </div>

        <div class="box">
          <h2>How to Fix in Vercel</h2>
          <p>To fix the missing environment variables in Vercel:</p>
          <ol>
            <li>Go to your <a href="https://vercel.com/dashboard" target="_blank">Vercel Dashboard</a></li>
            <li>Select your project (Saarthi)</li>
            <li>Click on "Settings" in the top navigation</li>
            <li>Select "Environment Variables" from the left sidebar</li>
            <li>Add each environment variable:
              <ul>
                <li><code>ATLASDB_URL</code>: Your MongoDB connection string</li>
                <li><code>SECRET</code>: A random string for session encryption</li>
                <li><code>GEMINI_API_KEY</code>: Your Google Gemini API key</li>
                <li><code>CLOUD_NAME</code>: Your Cloudinary cloud name</li>
                <li><code>CLOUD_API_KEY</code>: Your Cloudinary API key</li>
                <li><code>CLOUD_SECRET_KEY</code>: Your Cloudinary API secret</li>
              </ul>
            </li>
            <li>Make sure to select all environments (Production, Preview, Development) where appropriate</li>
            <li>Click "Save" after adding each variable</li>
            <li>Redeploy your application by going to the "Deployments" tab and clicking "Redeploy"</li>
          </ol>
        </div>

        <div class="box">
          <h2>How to Fix Locally</h2>
          <p>If you're running the application locally, create a <code>.env</code> file in the root directory with the following content:</p>
          <pre>ATLASDB_URL=mongodb+srv://username:password@cluster.mongodb.net/database
SECRET=your_random_secret_string
GEMINI_API_KEY=your_gemini_api_key
CLOUD_NAME=your_cloudinary_cloud_name
CLOUD_API_KEY=your_cloudinary_api_key
CLOUD_SECRET_KEY=your_cloudinary_api_secret</pre>
        </div>

        <div class="box">
          <h2>MongoDB Atlas Setup</h2>
          <p>If you need to create a MongoDB database:</p>
          <ol>
            <li>Go to <a href="https://www.mongodb.com/cloud/atlas" target="_blank">MongoDB Atlas</a> and create an account</li>
            <li>Create a new cluster (the free tier is sufficient)</li>
            <li>Click "Connect" on your cluster</li>
            <li>Select "Connect your application"</li>
            <li>Copy the connection string and replace &lt;password&gt; with your database user password</li>
            <li>Add this connection string as the <code>ATLASDB_URL</code> environment variable</li>
          </ol>
        </div>

        <div class="box">
          <h2>Gemini API Key</h2>
          <p>To get a Gemini API key:</p>
          <ol>
            <li>Go to <a href="https://ai.google.dev/" target="_blank">Google AI Studio</a></li>
            <li>Sign in with your Google account</li>
            <li>Navigate to the "API keys" section</li>
            <li>Create a new API key</li>
            <li>Copy the API key and add it as the <code>GEMINI_API_KEY</code> environment variable</li>
          </ol>
        </div>
        
        <div class="box">
          <h2>Cloudinary Setup</h2>
          <p>For image uploads to work in Vercel, you need to set up Cloudinary:</p>
          <ol>
            <li>Go to <a href="https://cloudinary.com" target="_blank">Cloudinary</a> and sign up for a free account</li>
            <li>Go to your Cloudinary Dashboard</li>
            <li>Find your Cloud Name, API Key, and API Secret</li>
            <li>Add these values to your Vercel environment variables as:</li>
            <ul>
              <li><code>CLOUD_NAME</code>: Your Cloudinary cloud name</li>
              <li><code>CLOUD_API_KEY</code>: Your Cloudinary API key</li>
              <li><code>CLOUD_SECRET_KEY</code>: Your Cloudinary API secret</li>
            </ul>
          </ol>
        </div>
        
        <div class="box">
          <h2>Need Help?</h2>
          <p>If you're still having issues, check the <a href="/_healthcheck" target="_blank">Health Check Endpoint</a> for more diagnostic information.</p>
        </div>
      </body>
    </html>
  `);
});

app.all("*", (req, res) => {
  // Define paths that should be accessible even without database
  const publicPaths = [
    "/main",
    "/login",
    "/signup",
    "/_debug",
    "/_healthcheck",
    "/",
  ];
  const isPublicPath = publicPaths.some(
    (path) =>
      req.path === path ||
      req.path.startsWith("/public/") ||
      req.path.startsWith("/images/")
  );

  // If it's not a public path and the database is not connected, show an error page
  if (!ENV.DB_URL && !isPublicPath) {
    return res.status(500).send(`
      <html>
        <head>
          <title>Saarthi - Configuration Error</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; text-align: center; }
            h1 { color: #d9534f; }
            .box { border: 1px solid #d9534f; padding: 20px; margin-bottom: 20px; border-radius: 5px; background: #f9f2f4; }
            a { color: #0275d8; text-decoration: none; }
            a:hover { text-decoration: underline; }
            .links { margin-top: 20px; }
            .links a { margin: 0 10px; }
          </style>
        </head>
        <body>
          <h1>⚠️ Configuration Error</h1>
          <div class="box">
            <p>The application is missing critical environment variables and cannot start properly.</p>
            <p>Please visit <a href="/_debug">the debug page</a> for more information on how to fix this issue.</p>
          </div>
          <p>If you're the site administrator, please configure your environment variables in the Vercel dashboard.</p>
          <div class="links">
            <a href="/main">Home</a> | 
            <a href="/login">Login</a> | 
            <a href="/signup">Signup</a>
          </div>
        </body>
      </html>
    `);
  }

  res.redirect("/main");
});

function fileToGenerativePart(path, mimeType) {
  try {
    if (!fs.existsSync(path)) {
      throw new Error(`File not found: ${path}`);
    }
    return {
      inlineData: {
        data: Buffer.from(fs.readFileSync(path)).toString("base64"),
        mimeType,
      },
    };
  } catch (error) {
    console.error(`Error reading file ${path}:`, error);
    throw error;
  }
}

async function problemSolving() {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = "";
      const imageParts = [fileToGenerativePart("prob.jpg", "image/jpeg")];
      const result = await model.generateContent([prompt, ...imageParts]);
      const response = await result.response;
      const text = response.text();
      console.log(text);
      return text;
    } catch (error) {
      console.error(`Error in problemSolving (attempt ${attempt}):`, error);
      lastError = error;

      // If it's an overload error, wait before retrying
      if (error.status === 503 || error.message?.includes("overloaded")) {
        if (attempt < maxRetries) {
          console.log(
            `Gemini API overloaded, retrying in ${attempt * 2} seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
      }

      // For other errors or after max retries, throw the error
      throw error;
    }
  }

  throw lastError;
}

async function textQuery(query) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const enhancedPrompt = `You are an AI educational assistant for Saarthi. Please provide a clear, structured response to: "${query}"

Guidelines:
- Use markdown formatting for structure
- Include bullet points for key concepts
- Use **bold** for important terms
- Be educational and encouraging
- Keep it concise but comprehensive`;

      const result = await model.generateContent(enhancedPrompt);
      const response = await result.response;
      const text = response.text();
      return text;
    } catch (error) {
      console.error(`Error in textQuery (attempt ${attempt}):`, error);
      lastError = error;

      // If it's an overload error, wait before retrying
      if (error.status === 503 || error.message?.includes("overloaded")) {
        if (attempt < maxRetries) {
          console.log(
            `Gemini API overloaded, retrying in ${attempt * 2} seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
      }

      // For other errors or after max retries, throw the error
      throw error;
    }
  }

  throw lastError;
}

async function syllabusGen(std, sub) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const enhancedPrompt = `Generate a comprehensive syllabus for ${std} grade ${sub} subject based on current National Educational Policy (NEP 2020).

Please structure the response with:
- Clear section headings using markdown (## for main sections, ### for subsections)
- Organized topics and subtopics
- Learning objectives for each unit
- Suggested activities and assessments
- Duration for each unit
- Key skills to be developed

Guidelines:
- Adapt content to the age and cognitive level of ${std} students
- Include modern pedagogical approaches
- Focus on skill development and practical application
- Use bullet points for better readability
- Make it engaging and student-friendly

Please provide a well-structured syllabus:`;

      const result = await model.generateContent(enhancedPrompt);
      const response = await result.response;
      const text = response.text();
      return text;
    } catch (error) {
      console.error(`Error in syllabusGen (attempt ${attempt}):`, error);
      lastError = error;

      // If it's an overload error, wait before retrying
      if (error.status === 503 || error.message?.includes("overloaded")) {
        if (attempt < maxRetries) {
          console.log(
            `Gemini API overloaded, retrying in ${attempt * 2} seconds...`
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }
      }

      // For other errors or after max retries, throw the error
      throw error;
    }
  }

  throw lastError;
}
