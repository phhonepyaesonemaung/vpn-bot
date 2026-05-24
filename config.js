require("dotenv").config();

const SERVERS = {
  SG: [process.env.SG_API_1, process.env.SG_API_2],
  JP: [process.env.JP_API_1]
};

const PLANS = {
  "50": { price: 3000, gb: 50 },
  "100": { price: 5000, gb: 100 },
  "200": { price: 7000, gb: 200 },
  "500": { price: 15000, gb: 500 }
};

const serverIndex = {};

function getServer(region) {
  if (!serverIndex[region]) serverIndex[region] = 0;

  const list = SERVERS[region];
  const server = list[serverIndex[region]];

  serverIndex[region] =
    (serverIndex[region] + 1) % list.length;

  return server;
}

module.exports = { SERVERS, PLANS, getServer };