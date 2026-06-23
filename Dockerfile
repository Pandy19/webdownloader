# Use official Node.js runtime as parent image
FROM node:20-slim

# Install system dependencies: python3, ffmpeg, curl, unzip (required for Deno)
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Download the latest yt-dlp binary, make it executable, and move to bin PATH
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Install Deno (the preferred JS runtime for yt-dlp signature challenges)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Verify that the dependencies are installed correctly in the image
RUN node -v \
    && ffmpeg -version \
    && deno --version \
    && yt-dlp --version

# Set environment to production
ENV NODE_ENV=production

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy package configuration and install production packages only
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the web app files
COPY . .

# Expose the default server port
EXPOSE 3000

# Start the Node.js application
CMD ["node", "server.js"]
