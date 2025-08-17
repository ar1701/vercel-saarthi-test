// Forward to api/index.js for Vercel serverless functions
// This file is the entry point for the Vercel deployment
module.exports = require("./api/index.js");

const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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
  try {
    // For text-and-image input (multimodal), use the gemini-1.5-flash model
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = "";

    const imageParts = [
      fileToGenerativePart("prob.jpg", "image/jpeg"),
      //   fileToGenerativePart("image2.jpeg", "image/jpeg"),
    ];

    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = response.text();
    console.log(text);
  } catch (error) {
    console.error("Error in problemSolving:", error);
  }
}

// problemSolving();

async function textQuery() {
  try {
    // For text-only input, use the gemini-1.5-flash model
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = "What is Newton's First Law ?";

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log(text);
  } catch (error) {
    console.error("Error in textQuery:", error);
  }
}

// textQuery();

async function chatBot() {
  // For text-only input, use the gemini-1.5-flash model
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const chat = model.startChat({
    history: [],
    generationConfig: {
      maxOutputTokens: 100,
    },
  });

  async function askAndRespond() {
    rl.question("You: ", async (msg) => {
      if (msg.toLowerCase() === "exit") {
        rl.close();
      } else {
        try {
          const result = await model.generateContent(msg);
          const response = await result.response;
          const text = await response.text();
          console.log("AI: ", text);
        } catch (error) {
          console.error("Error in chat:", error);
          console.log("AI: Sorry, I encountered an error. Please try again.");
        }
        askAndRespond();
      }
    });
  }
  askAndRespond();
}

chatBot();
