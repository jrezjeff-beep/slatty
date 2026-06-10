# Apify Puppeteer + Chrome base image
FROM apify/actor-node-puppeteer-chrome:20

# Copy package files
COPY package*.json ./

# Install dependencies including stealth plugin
RUN npm install --omit=dev

# Copy actor source
COPY . ./

# Run the actor
CMD npm start
