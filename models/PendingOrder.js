const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  username: String,
  type: { type: String, enum: ["new", "renew"], default: "new" },
  region: String,
  plan: String,
  amount: Number,
  status: {
    type: String,
    enum: ["awaiting_payment", "pending_admin", "approved", "rejected", "needs_better_screenshot"],
    default: "awaiting_payment",
    index: true
  },
  screenshotFileId: String,
  screenshotKind: String,
  referredBy: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  reviewedAt: Date
});

schema.pre("save", function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("PendingOrder", schema);
