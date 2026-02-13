FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# NEW: Install Timezone Data for Alpine Linux so Central Time works flawlessly!
RUN apk add --no-cache tzdata

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the bot code
COPY . .

# Start the bot
CMD [ "node", "bot.js" ]
