const zmq = require('zeromq');
const Mutex = require('async-mutex').Mutex;

const {
	Connection,
	PublicKey
} = require('@solana/web3.js');
const {
	Market, MARKETS
} = require('@project-serum/serum');
const {
	TokenListProvider,
	TokenInfo
} = require('@solana/spl-token-registry');

const Firestore = require('@google-cloud/firestore');
const firestore = new Firestore({
	projectId: "nlc-bot-36685",
});
const {
	ErrorReporting
} = require('@google-cloud/error-reporting');
const errors = new ErrorReporting();
const {
	v4: uuidv4
} = require('uuid');


let connection = new Connection('https://solana-api.projectserum.com');
let marketOptions = {};


const main = async () => {
	console.log("[Startup]: Serum server is online");

	const mutex = new Mutex();
	const sock = new zmq.Router();
	await sock.bind("tcp://*:6900");

	while (true) {
		try {
			const message = await sock.receive();

			// Pop received data and decode it
			const request = JSON.parse(message.pop().toString());
			const delimeter = message.pop();
			const origin = message.pop();

			let response = {};

			if (request.endpoint === "list") {
				new TokenListProvider().resolve().then(tokens => {
					response.tokenList = tokens.filterByClusterSlug('mainnet-beta').getList();
					response.markets = MARKETS.filter(market => !market.deprecated).map(market => {
						return {
							address: market.address.toString(),
							name: market.name,
							programId: market.programId.toString()
						}
					});
					mutex.runExclusive(async () => {
						await sock.send([origin, delimeter, JSON.stringify(response)]);
					});
				});
			} else if (request.endpoint === "quote") {
				let marketAddress = new PublicKey(request.marketAddress);
				let programId = new PublicKey(request.program);
				let market = await Market.load(connection, marketAddress, marketOptions, programId);

				let bids = await market.loadBids(connection);
				let asks = await market.loadAsks(connection);
				let [bidPrice, bidSize] = bids.getL2(1)[0];
				let [askPrice, askSize] = asks.getL2(1)[0];

				response.price = ((bidPrice * bidSize + askPrice * askSize) / (bidSize + askSize)).toFixed(-Math.floor(Math.log10(market.tickSize)));

				mutex.runExclusive(async () => {
					await sock.send([origin, delimeter, JSON.stringify(response)]);
				});
			} else if (request.endpoint === "depth") {
				let marketAddress = new PublicKey(request.marketAddress);
				let programId = new PublicKey(request.program);
				let market = await Market.load(connection, marketAddress, marketOptions, programId);

				let bids = await market.loadBids(connection);
				let asks = await market.loadAsks(connection);

				response.bids = bids.map(bid => {
					return [bid.price, bid.size]
				});

				response.asks = asks.map(ask => {
					return [ask.price, ask.size]
				});

				mutex.runExclusive(async () => {
					await sock.send([origin, JSON.stringify(response)]);
				});
			}

		} catch (error) {
			console.error(error);
			if (process.env.PRODUCTION_MODE) errors.report(error);
		}
	};
};

main();