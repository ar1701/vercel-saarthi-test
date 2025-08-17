const mongoose = require("mongoose");

const quizResultSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  topic: {
    type: String,
    required: true,
  },
  difficulty: {
    type: String,
    required: true,
  },
  questionType: {
    type: String,
    required: true,
  },
  totalQuestions: {
    type: Number,
    required: true,
  },
  correctAnswers: {
    type: Number,
    required: true,
  },
  score: {
    type: Number,
    required: true,
  },
  userAnswers: [
    {
      questionNumber: Number,
      userAnswer: String,
      correctAnswer: String,
      isCorrect: Boolean,
    },
  ],
  timeTaken: {
    type: Number, // in seconds
    default: 0,
  },
  completedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("QuizResult", quizResultSchema);
