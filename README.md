# CollectorAnalytics

Home page with centered logo and user login/registration backed by SQL Server.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and set your database credentials: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.
3. Run the server:
   ```bash
   npm start
   ```
4. Open **http://localhost:3000** in your browser.

## Features

- **Home:** Centered CollectorAnalytics logo; login form (email, password, sign in) and “Create an account” link in the upper right.
- **Logged in:** Login is replaced by “Welcome, [First Name]” and a sign-out option; user stays on the home page.
- **Registration:** First name, last name, email, password (all required). After signup, user is logged in and redirected to the home page.

Passwords are hashed with bcrypt. Session cookie keeps the user logged in until they sign out.
