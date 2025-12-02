// npm init -y to start the setup
// npm install express ejs dotenv knex pg to install dependancies
// npm install --save-dev nodemon
// instead of doing node index.js do npm run dev
// test again

// import necessary modules
import express from "express";
import knex from "knex";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config'; 
import session from "express-session";

// This lets us access the current path and directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

//Set up server and port
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// This allows req.body to be used for POST requests.
app.use(express.urlencoded({ extended: true }));

// Knex configuration
const db = knex({
    client: "pg",
    connection: {
        host: process.env.RDS_HOSTNAME,
        user: process.env.RDS_USERNAME,
        password: process.env.RDS_PASSWORD,
        database: process.env.RDS_DB_NAME || "ebdb",
        port: process.env.RDS_PORT ? parseInt(process.env.RDS_PORT) : 5432,
        ssl: { rejectUnauthorized: false } 
    }
});

// Sets up session management so you can track the login state of a user.
app.use(
    session(
        {
            secret: process.env.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
        }
    )
);

// Global authentication middleware - runs on EVERY request
// This lets users only access the login page if not logged in.
app.use((req, res, next) => {
    // Skip authentication for login routes
    if (req.path === '/' || req.path === '/login' || req.path === '/logout') {
        //continue with the request path
        return next();
    }
    
    // Check if user is logged in for all other routes
    if (req.session.isLoggedIn) {
        next(); // If user is logged in, continue
    } 
    else {
        res.render("login", { error_message: "Please log in to access this page" });
    }
});

// Root route
app.get("/", (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render("login", { error_message: "", title: "Login" });
  }

  // Just render the home page without querying the books table
  // Passing empty bookList[] in case your ejs file still tries to loop through it
  res.render("index", { 
    username: req.session.username
  });
});


// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  console.log("--- LOGIN ATTEMPT ---");
  console.log("Username submitted:", username);
  console.log("Password submitted:", password);

  try {
    // Find user by username first
    const user = await db("users").where({ username: username }).first();

    console.log("Database result for user:", user);

    // Check if user exists and password matches
    if (user && user.password === password) {
      console.log("SUCCESS: Credentials match.");
      req.session.isLoggedIn = true;
      req.session.username = user.username;
      
      // Explicitly save session before redirecting to ensure race conditions don't kill the cookie
      req.session.save(err => {
        if (err) {
            console.log("Session save error:", err);
            return res.status(500).send("Session error");
        }
        res.redirect("/");
      });
      
    } else {
      console.log("FAILURE: User not found OR password mismatch.");
      // Invalid login — still pass a title for the template
      res.render("login", { 
        error_message: "Invalid login", 
        title: "Login" 
      });
    }
  } catch (err) {
    console.error("CRITICAL Login error:", err);
    res.render("login", { 
      error_message: "Login Error: " + err.message, 
      title: "Login" 
    });
  }
});


// Logout route
app.get("/logout", (req, res) => {
    // Get rid of the session object
    req.session.destroy((err) => {
        if (err) {
            console.log(err);
        }
        res.redirect("/");
    });
});

// start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));