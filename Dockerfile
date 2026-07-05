FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Expose the port (Hugging Face Spaces requires port 7860 by default)
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
