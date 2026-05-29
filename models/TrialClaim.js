const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("TrialClaim", schema);
