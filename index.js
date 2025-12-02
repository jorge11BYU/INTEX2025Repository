import express from "express";
import knex from "knex";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config'; 
import session from "express-session";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public"))); // Allow access to CSS/Images
app.use(express.urlencoded({ extended: true }));

// Database Connection
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

// Session Config
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS in production
}));

// --- CUSTOM MIDDLEWARE ---

// 1. Check if user is logged in
const isLoggedIn = (req, res, next) => {
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.redirect('/login');
    }
};

// 2. Check if user is a Manager (for CRUD operations)
const isManager = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'manager') {
        next();
    } else {
        res.status(403).send("Access Denied: Managers only.");
    }
};

// --- ROUTES ---

// 1. Public Landing Page (No Login Required)
app.get("/", (req, res) => {
    res.render("landing", { 
        isLoggedIn: req.session.isLoggedIn, 
        username: req.session.username 
    });
});

// 2. Auth Routes
app.get("/login", (req, res) => {
    res.render("login", { 
        error_message: null,
        isLoggedIn: req.session.isLoggedIn 
    });
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db("users").where({ username }).first();
        if (user && user.password === password) {
            req.session.isLoggedIn = true;
            req.session.username = user.username;
            req.session.role = user.role; // Store role in session!
            req.session.save(() => res.redirect("/dashboard"));
        } else {
            res.render("login", { 
                error_message: "Invalid credentials",
                isLoggedIn: false
            });
        }
    } catch (err) {
        console.error(err);
        res.render("login", { 
            error_message: "System Error",
            isLoggedIn: false
        });
    }
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
});

// 3. Private Dashboard
app.get("/dashboard", isLoggedIn, async (req, res) => {
    // Determine greeting based on time
    const hour = new Date().getHours();
    let greeting = "Good Morning";
    if (hour > 12) greeting = "Good Afternoon";
    if (hour > 17) greeting = "Good Evening";

    let stats = { participants: 0, events: 0, donations: 0 };
    try {
        const pCount = await db("participants").count("participant_id as count").first();
        // const eCount = await db("event_occurrences").count("event_occurrence_id as count").first();
        // const dCount = await db("donations").count("donation_id as count").first();
        
        stats.participants = pCount ? pCount.count : 0;
        // stats.events = eCount ? eCount.count : 0;
        // stats.donations = dCount ? dCount.count : 0;
    } catch (e) {
        console.log("Error fetching stats:", e);
    }

    res.render("dashboard", {
        user: req.session.username,
        role: req.session.role,
        isLoggedIn: req.session.isLoggedIn, // FIXED: Added this
        greeting: greeting,
        stats: stats
    });
});

// 4. Participants Management (The CRUD Example)

// READ (List)
app.get("/participants", isLoggedIn, async (req, res) => {
    try {
        const participants = await db("participants").select("*").orderBy("participant_id");
        res.render("participants", { 
            participants, 
            role: req.session.role,
            isManager: req.session.role === 'manager',
            user: req.session.username,       // FIXED: Added this
            isLoggedIn: req.session.isLoggedIn // FIXED: Added this
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error retrieving participants");
    }
});

// CREATE (Form - Manager Only)
app.get("/participants/add", isManager, (req, res) => {
    res.render("participants_add", {
        user: req.session.username,       // FIXED: Added this
        isLoggedIn: req.session.isLoggedIn // FIXED: Added this
    });
});

// CREATE (Submit - Manager Only)
app.post("/participants/add", isManager, async (req, res) => {
    try {
        await db("participants").insert({
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            email: req.body.email,
            phone: req.body.phone,
            dob: req.body.dob || null, // Handle empty dates
            city: req.body.city,
            state: req.body.state,
            zip_code: req.body.zip_code,
            school_or_employer: req.body.school_or_employer
        });
        res.redirect("/participants");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding participant");
    }
});

// UPDATE (Form - Manager Only)
app.get("/participants/edit/:id", isManager, async (req, res) => {
    try {
        const participant = await db("participants").where({ participant_id: req.params.id }).first();
        res.render("participants_edit", { 
            participant,
            user: req.session.username,       // FIXED: Added this
            isLoggedIn: req.session.isLoggedIn // FIXED: Added this
        });
    } catch (err) {
        res.status(404).send("Participant not found");
    }
});

// UPDATE (Submit - Manager Only)
app.post("/participants/edit/:id", isManager, async (req, res) => {
    try {
        await db("participants").where({ participant_id: req.params.id }).update({
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            email: req.body.email,
            phone: req.body.phone,
            dob: req.body.dob || null,
            city: req.body.city,
            state: req.body.state,
            zip_code: req.body.zip_code,
            school_or_employer: req.body.school_or_employer
        });
        res.redirect("/participants");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating participant");
    }
});

// DELETE (Manager Only)
app.post("/participants/delete/:id", isManager, async (req, res) => {
    try {
        await db("participants").where({ participant_id: req.params.id }).del();
        res.redirect("/participants");
    } catch (err) {
        console.error(err);
        // This usually fails if the participant is linked to other tables (Foreign Key)
        res.status(500).send("Error deleting participant. They might be linked to registrations or donations.");
    }
});

// 5. The "Teapot" Requirement
app.get("/teapot", (req, res) => {
    res.status(418).send("418: I'm a little teapot, short and stout. This server refuses to brew coffee because it is, permanently, a teapot.");
});

app.listen(PORT, () => console.log(`Ella Rises running on port ${PORT}`));