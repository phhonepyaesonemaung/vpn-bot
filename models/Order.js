const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: String,
  amount: Number,
  region: String,
  plan: String,
  type: { type: String, default: "new" },
  pendingOrderId: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Order", schema);
