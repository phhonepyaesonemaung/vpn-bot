const mongoose = require("../db");

const schema = new mongoose.Schema({
  telegramId: String,
  region: String,
  plan: String,
  key: String,
  keyId: String,
  server: String,
  expireAt: Date,
  active: Boolean
});

module.exports = mongoose.model("User", schema);