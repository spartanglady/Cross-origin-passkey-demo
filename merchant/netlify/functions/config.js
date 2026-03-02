// Netlify specific serverless function format
exports.handler = async (event, context) => {
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Allow cross-domain fetch from merchant code if needed
        },
        body: JSON.stringify({
            WALLET_ORIGIN: process.env.WALLET_ORIGIN || '',
        }),
    };
};
