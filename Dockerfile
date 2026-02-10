FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package.json
COPY package.json ./

# Install dependencies (This generates the missing lockfile automatically)
RUN npm install

# Copy the rest of the bot code
COPY . .

# Start the bot
CMD [ "node", "bot.js" ]
