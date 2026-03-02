# Sample Express App

A simple Express application to demonstrate Testbot MCP testing.

## Quick Start

### 1. Install Dependencies

```bash
cd examples/sample-project
npm install
```

### 2. Start the App

```bash
npm start
```

The app runs at http://localhost:3000

### 3. Test with Testbot

In Cursor or Windsurf:

> "Test my app using testbot mcp"

## Pages

- **Home** (`/`): Welcome page
- **Users** (`/users`): User list
- **About** (`/about`): About page
- **Contact** (`/contact`): Contact form

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users` | Create user |
| DELETE | `/api/users/:id` | Delete user |

## Test Scenarios

Testbot will generate tests for:

1. Page loading and display
2. Navigation between pages
3. API endpoint functionality
4. Form validation
5. Error handling
