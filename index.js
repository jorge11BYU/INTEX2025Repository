// npm init -y to start the setup
// npm install express ejs dotenv knex pg to install dependancies
// npm install --save-dev nodemon
// instead of doing node index.js do npm run dev

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
        host: process.env.DB_HOST || "localhost",
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "admin",
        database: process.env.DB_NAME || "Practice",
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432
    }
});

// Sets up session management so you can track the login state of a user.
app.use(
    session(
        {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
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
app.get("/", async (req, res) => {
  if (!req.session.isLoggedIn) {
    return res.render("login", { error_message: "", title: "Login" });
  }

  try {
    // Check query parameter
    const sortBy = req.query.sort;

    let query = db("books").select("*");
    
    if (sortBy === "author") {
      query = query.orderBy("author", "asc");
    } else if (sortBy === "description") {
      query = query.orderBy("description", "asc");
    } else {
      query = query.orderBy("id", "asc"); // default
    }

    const bookList = await query;

    res.render("index", { 
      bookList,
      title: "Home Page",
      username: req.session.username
    });
  } catch (err) {
    console.error("Database error:", err.message);
    res.status(500).send("Database error");
  }
});


// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Find user by username first
    const user = await db("users").where({ username }).first();

    // Check if user exists and password matches
    if (user && user.password === password) {
      req.session.isLoggedIn = true;
      req.session.username = user.username;
      res.redirect("/");
    } else {
      // Invalid login — still pass a title for the template
      res.render("login", { 
        error_message: "Invalid login", 
        title: "Login" 
      });
    }
  } catch (err) {
    console.error("Login error:", err);
    res.render("login", { 
      error_message: "Invalid login", 
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
