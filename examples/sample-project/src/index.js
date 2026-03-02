/**
 * Sample Express Application
 * Used to demonstrate Testbot MCP testing
 */

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory data store
let users = [
  { id: 1, name: 'John Doe', email: 'john@example.com' },
  { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
];

// Routes

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sample App - Testbot Demo</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #3b82f6; }
        nav { margin: 20px 0; }
        nav a { margin-right: 15px; color: #3b82f6; text-decoration: none; }
        .card { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1>Sample App</h1>
      <nav>
        <a href="/">Home</a>
        <a href="/users">Users</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
      </nav>
      <div class="card">
        <h2>Welcome to Sample App</h2>
        <p>This is a demo application for testing with Testbot MCP.</p>
        <p>Try running: "Test my app using testbot mcp"</p>
      </div>
    </body>
    </html>
  `);
});

// Users page
app.get('/users', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Users - Sample App</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #3b82f6; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
        th { background: #f9fafb; }
      </style>
    </head>
    <body>
      <h1>Users</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${u.id}</td>
              <td>${u.name}</td>
              <td>${u.email}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// About page
app.get('/about', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>About - Sample App</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #3b82f6; }
      </style>
    </head>
    <body>
      <h1>About</h1>
      <p>This is a sample application designed to demonstrate Testbot MCP capabilities.</p>
      <p>Features:</p>
      <ul>
        <li>Express.js backend</li>
        <li>Simple user management</li>
        <li>RESTful API</li>
      </ul>
    </body>
    </html>
  `);
});

// Contact page
app.get('/contact', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Contact - Sample App</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #3b82f6; }
        form { display: flex; flex-direction: column; gap: 15px; max-width: 400px; }
        input, textarea { padding: 10px; border: 1px solid #e5e7eb; border-radius: 4px; }
        button { padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #2563eb; }
      </style>
    </head>
    <body>
      <h1>Contact</h1>
      <form id="contactForm">
        <input type="text" name="name" placeholder="Your Name" required>
        <input type="email" name="email" placeholder="Your Email" required>
        <textarea name="message" placeholder="Your Message" rows="5" required></textarea>
        <button type="submit">Send Message</button>
      </form>
    </body>
    </html>
  `);
});

// API Routes

// Get all users
app.get('/api/users', (req, res) => {
  res.json(users);
});

// Get user by ID
app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

// Create user
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  const newUser = {
    id: users.length + 1,
    name,
    email
  };
  users.push(newUser);
  res.status(201).json(newUser);
});

// Delete user
app.delete('/api/users/:id', (req, res) => {
  const index = users.findIndex(u => u.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }
  users.splice(index, 1);
  res.status(204).send();
});

// Start server
app.listen(port, () => {
  console.log(`Sample app running at http://localhost:${port}`);
});
