# Use a Go image to build the application
FROM golang:1.22 as builder

WORKDIR /app

# Copy the Go module files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy the rest of the source code
COPY . .

# Build the ka executable
RUN CGO_ENABLED=0 GOOS=linux go build -o ka ./

# Use a minimal image for the final stage
FROM alpine:latest

WORKDIR /app

# Copy the built executable from the builder stage
COPY --from=builder /app/ka .
COPY --from=builder /app/tools ./tools
COPY --from=builder /app/llm ./llm
COPY --from=builder /app/a2a ./a2a
COPY --from=builder /app/middleware ./middleware

# Expose the default server port
EXPOSE 8080

# Command to run the ka agent in server mode by default
CMD ["./ka", "server"]
