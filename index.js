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
app.use(express.static(path.join(__dirname, "public")));
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
    cookie: { secure: false }
}));

// --- MIDDLEWARE ---
const isLoggedIn = (req, res, next) => {
    if (req.session.isLoggedIn) next();
    else res.redirect('/login');
};

const isManager = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'manager') next();
    else res.status(403).send("Access Denied: Managers only.");
};

// --- ROUTES ---

// 1. Public Pages
app.get("/", (req, res) => {
    res.render("landing", { isLoggedIn: req.session.isLoggedIn, username: req.session.username, role: req.session.role });
});

app.get("/donate", (req, res) => {
    res.render("donate_public", { user: req.session.username, isLoggedIn: req.session.isLoggedIn, role: req.session.role, success_message: null });
});

app.post("/donate", async (req, res) => {
    const { first_name, last_name, email, donation_amount } = req.body;
    try {
        let participantId;
        const existing = await db("participants").where({ email }).first();
        if (existing) {
            participantId = existing.participant_id;
        } else {
            const [newP] = await db("participants").insert({ first_name, last_name, email }).returning('participant_id');
            participantId = newP.participant_id;
        }
        await db("donations").insert({ participant_id: participantId, donation_amount, donation_date: new Date() });
        res.render("donate_public", { user: req.session.username, isLoggedIn: req.session.isLoggedIn, role: req.session.role, success_message: `Thank you, ${first_name}!` });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error processing donation.");
    }
});

// 2. Auth Routes
app.get("/login", (req, res) => res.render("login", { error_message: null, isLoggedIn: req.session.isLoggedIn }));
app.post("/login", async (req, res) => {
    try {
        const user = await db("users").where({ username: req.body.username }).first();
        if (user && user.password === req.body.password) {
            req.session.isLoggedIn = true;
            req.session.username = user.username;
            req.session.role = user.role;
            req.session.save(() => res.redirect("/dashboard"));
        } else {
            res.render("login", { error_message: "Invalid credentials", isLoggedIn: false });
        }
    } catch (err) {
        res.render("login", { error_message: "System Error", isLoggedIn: false });
    }
});
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// 3. Dashboard
app.get("/dashboard", isLoggedIn, async (req, res) => {
    const hour = new Date().getHours();
    let greeting = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";
    let stats = { participants: 0, events: 0, donations: 0 };
    try {
        const p = await db("participants").count("participant_id as count").first();
        const d = await db("donations").count("donation_id as count").first();
        const e = await db("event_occurrences").count("event_occurrence_id as count").first();
        stats = { participants: p.count, donations: d.count, events: e.count };
    } catch (e) {}
    res.render("dashboard", { user: req.session.username, role: req.session.role, isLoggedIn: true, greeting, stats });
});

// 4. PARTICIPANTS (View: Everyone, Edit: Manager)
app.get("/participants", isLoggedIn, async (req, res) => {
    const participants = await db("participants").select("*").orderBy("participant_id");
    res.render("participants", { participants, role: req.session.role, isManager: req.session.role === 'manager', user: req.session.username, isLoggedIn: true });
});
app.get("/participants/add", isManager, (req, res) => res.render("participants_add", { user: req.session.username, isLoggedIn: true, returnTo: req.query.returnTo }));
app.post("/participants/add", isManager, async (req, res) => {
    try {
        const [newP] = await db("participants").insert(req.body).returning('participant_id'); // Ensure body matches DB cols or filter manually
        if (req.body.returnTo === 'donations_add') res.redirect(`/donations/add?newParticipantId=${newP.participant_id}`);
        else res.redirect("/participants");
    } catch (err) { console.error(err); res.status(500).send("Error adding participant"); }
});
app.get("/participants/edit/:id", isManager, async (req, res) => {
    const participant = await db("participants").where({ participant_id: req.params.id }).first();
    res.render("participants_edit", { participant, user: req.session.username, isLoggedIn: true });
});
app.post("/participants/edit/:id", isManager, async (req, res) => {
    await db("participants").where({ participant_id: req.params.id }).update({
        first_name: req.body.first_name, last_name: req.body.last_name, email: req.body.email, phone: req.body.phone,
        dob: req.body.dob || null, city: req.body.city, state: req.body.state, zip_code: req.body.zip_code, school_or_employer: req.body.school_or_employer
    });
    res.redirect("/participants");
});
app.post("/participants/delete/:id", isManager, async (req, res) => {
    await db("participants").where({ participant_id: req.params.id }).del();
    res.redirect("/participants");
});

// 5. DONATIONS (View: Everyone, Edit: Manager)
app.get("/donations", isLoggedIn, async (req, res) => {
    const donations = await db("donations")
        .join("participants", "donations.participant_id", "participants.participant_id")
        .select("donations.*", "participants.first_name", "participants.last_name")
        .orderBy("donations.donation_date", "desc");
    res.render("donations", { donations, role: req.session.role, isManager: req.session.role === 'manager', user: req.session.username, isLoggedIn: true });
});
app.get("/donations/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("donations_add", { participants, user: req.session.username, isLoggedIn: true, newParticipantId: req.query.newParticipantId });
});
app.post("/donations/add", isManager, async (req, res) => {
    await db("donations").insert({ participant_id: req.body.participant_id, donation_date: req.body.donation_date, donation_amount: req.body.donation_amount });
    res.redirect("/donations");
});
app.get("/donations/edit/:id", isManager, async (req, res) => {
    const donation = await db("donations").where({ donation_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("donations_edit", { donation, participants, user: req.session.username, isLoggedIn: true });
});
app.post("/donations/edit/:id", isManager, async (req, res) => {
    await db("donations").where({ donation_id: req.params.id }).update({ participant_id: req.body.participant_id, donation_date: req.body.donation_date, donation_amount: req.body.donation_amount });
    res.redirect("/donations");
});
app.post("/donations/delete/:id", isManager, async (req, res) => {
    await db("donations").where({ donation_id: req.params.id }).del();
    res.redirect("/donations");
});

// 6. SURVEYS (View: Everyone, Edit: Manager)
app.get("/surveys", isLoggedIn, async (req, res) => {
    const surveys = await db("surveys")
        .join("participants", "surveys.participant_id", "participants.participant_id")
        .join("event_occurrences", "surveys.event_occurrence_id", "event_occurrences.event_occurrence_id")
        .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
        .select("surveys.*", "participants.first_name", "participants.last_name", "event_templates.event_name", "event_occurrences.start_time")
        .orderBy("surveys.submission_date", "desc");
    res.render("surveys", { surveys, role: req.session.role, isManager: req.session.role === 'manager', user: req.session.username, isLoggedIn: true });
});
app.get("/surveys/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const events = await db("event_occurrences").join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id").select("event_occurrences.event_occurrence_id", "event_templates.event_name", "event_occurrences.start_time").orderBy("event_occurrences.start_time", "desc");
    const npsBuckets = await db("nps_buckets").select("*");
    res.render("surveys_add", { participants, events, npsBuckets, user: req.session.username, isLoggedIn: true });
});
app.post("/surveys/add", isManager, async (req, res) => {
    await db("surveys").insert({ ...req.body, submission_date: new Date() });
    res.redirect("/surveys");
});
app.get("/surveys/edit/:id", isManager, async (req, res) => {
    const survey = await db("surveys").where({ survey_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const events = await db("event_occurrences").join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id").select("event_occurrences.event_occurrence_id", "event_templates.event_name", "event_occurrences.start_time").orderBy("event_occurrences.start_time", "desc");
    const npsBuckets = await db("nps_buckets").select("*");
    res.render("surveys_edit", { survey, participants, events, npsBuckets, user: req.session.username, isLoggedIn: true });
});
app.post("/surveys/edit/:id", isManager, async (req, res) => {
    await db("surveys").where({ survey_id: req.params.id }).update(req.body);
    res.redirect("/surveys");
});
app.post("/surveys/delete/:id", isManager, async (req, res) => {
    await db("surveys").where({ survey_id: req.params.id }).del();
    res.redirect("/surveys");
});

// 7. EVENTS (New Section)
app.get("/events", isLoggedIn, async (req, res) => {
    const events = await db("event_occurrences")
        .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
        .join("locations", "event_occurrences.location_id", "locations.location_id")
        .select("event_occurrences.*", "event_templates.event_name", "event_templates.event_description", "locations.location_name")
        .orderBy("event_occurrences.start_time", "desc");
    res.render("events", { events, role: req.session.role, isManager: req.session.role === 'manager', user: req.session.username, isLoggedIn: true });
});
app.get("/events/add", isManager, async (req, res) => {
    const templates = await db("event_templates").select("*");
    const locations = await db("locations").select("*");
    res.render("events_add", { templates, locations, user: req.session.username, isLoggedIn: true });
});
app.post("/events/add", isManager, async (req, res) => {
    await db("event_occurrences").insert(req.body);
    res.redirect("/events");
});
app.get("/events/edit/:id", isManager, async (req, res) => {
    const event = await db("event_occurrences").where({ event_occurrence_id: req.params.id }).first();
    const templates = await db("event_templates").select("*");
    const locations = await db("locations").select("*");
    res.render("events_edit", { event, templates, locations, user: req.session.username, isLoggedIn: true });
});
app.post("/events/edit/:id", isManager, async (req, res) => {
    await db("event_occurrences").where({ event_occurrence_id: req.params.id }).update(req.body);
    res.redirect("/events");
});
app.post("/events/delete/:id", isManager, async (req, res) => {
    await db("event_occurrences").where({ event_occurrence_id: req.params.id }).del();
    res.redirect("/events");
});

// 8. MILESTONES (New Section)
app.get("/milestones", isLoggedIn, async (req, res) => {
    const milestones = await db("milestones")
        .join("participants", "milestones.participant_id", "participants.participant_id")
        .join("milestone_types", "milestones.milestone_type_id", "milestone_types.milestone_type_id")
        .select("milestones.*", "participants.first_name", "participants.last_name", "milestone_types.milestone_title")
        .orderBy("milestones.milestone_date", "desc");
    res.render("milestones", { milestones, role: req.session.role, isManager: req.session.role === 'manager', user: req.session.username, isLoggedIn: true });
});
app.get("/milestones/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const types = await db("milestone_types").select("*");
    res.render("milestones_add", { participants, types, user: req.session.username, isLoggedIn: true });
});
app.post("/milestones/add", isManager, async (req, res) => {
    await db("milestones").insert(req.body);
    res.redirect("/milestones");
});
app.get("/milestones/edit/:id", isManager, async (req, res) => {
    const milestone = await db("milestones").where({ milestone_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const types = await db("milestone_types").select("*");
    res.render("milestones_edit", { milestone, participants, types, user: req.session.username, isLoggedIn: true });
});
app.post("/milestones/edit/:id", isManager, async (req, res) => {
    await db("milestones").where({ milestone_id: req.params.id }).update(req.body);
    res.redirect("/milestones");
});
app.post("/milestones/delete/:id", isManager, async (req, res) => {
    await db("milestones").where({ milestone_id: req.params.id }).del();
    res.redirect("/milestones");
});

// Teapot
app.get("/teapot", isLoggedIn, (req, res) => res.status(418).render("teapot", { user: req.session.username, isLoggedIn: true, role: req.session.role }));

app.listen(PORT, () => console.log(`Ella Rises running on port ${PORT}`));