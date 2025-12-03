import express from "express";
import knex from "knex";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config'; 
import session from "express-session";

// --- NEW IMPORTS FOR FILE UPLOAD ---
import { S3Client } from "@aws-sdk/client-s3";
import multer from "multer";
import multerS3 from "multer-s3";

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

// --- DEBUGGING START ---
console.log("------------------------------------------------");
console.log("DEBUG: Checking Environment Variables");
console.log("Region:", process.env.AWS_REGION);
console.log("Bucket:", process.env.S3_BUCKET_NAME);
console.log("Access Key ID:", process.env.AWS_ACCESS_KEY_ID ? "✔ LOADED (" + process.env.AWS_ACCESS_KEY_ID.substring(0, 5) + "...)" : "❌ MISSING (Undefined)");
console.log("Secret Access Key:", process.env.AWS_SECRET_ACCESS_KEY ? "✔ LOADED" : "❌ MISSING (Undefined)");
console.log("------------------------------------------------");
// --- DEBUGGING END ---

// --- AWS S3 & MULTER CONFIGURATION ---
const s3 = new S3Client({
    region: process.env.AWS_REGION, // Ensure this is set in .env
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,     // Ensure this is set in .env
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY // Ensure this is set in .env
    }
});

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET_NAME, // Ensure this is set in .env
        acl: 'public-read', // Makes the uploaded file readable by browsers
        contentType: multerS3.AUTO_CONTENT_TYPE, // Automatically detects jpeg/png
        key: function (req, file, cb) {
            // Naming convention: profile-pics/timestamp-filename
            cb(null, `profile-pics/${Date.now().toString()}-${file.originalname}`);
        }
    })
});

// --- CUSTOM MIDDLEWARE ---

// 1. Auth Checkers
const isLoggedIn = (req, res, next) => {
    if (req.session.isLoggedIn) next();
    else res.redirect('/login');
};

const isManager = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'manager') next();
    else res.status(403).send("Access Denied: Managers only.");
};

// 2. Global View Variables (NEW)
// This passes the user info & profile picture to EVERY .ejs file automatically
app.use(async (req, res, next) => {
    res.locals.isLoggedIn = req.session.isLoggedIn || false;
    res.locals.user = req.session.username || null;
    res.locals.role = req.session.role || null;
    res.locals.userProfilePic = req.session.profilePictureUrl || null;
    next();
});


// --- ROUTES ---

// 1. Landing & Public Donation
app.get("/", (req, res) => {
    res.render("landing");
});

// PUBLIC SIGNUP PAGE
app.get("/signup", (req, res) => {
    res.render("signup", { error_message: null });
});

app.post("/signup", async (req, res) => {
    const { username, password, first_name, last_name, email } = req.body;
    try {
        // 1. Create the Participant Record first
        const [newPerson] = await db("participants").insert({
            first_name,
            last_name,
            email
        }).returning('participant_id');

        // 2. Create the User Login linked to that person
        await db("users").insert({
            username,
            password,
            role: 'user', // Default to common user
            participant_id: newPerson.participant_id
        });

        // 3. Auto-login and redirect
        req.session.isLoggedIn = true;
        req.session.username = username;
        req.session.role = 'user';
        req.session.participantId = newPerson.participant_id;
        
        req.session.save(() => res.redirect("/dashboard"));

    } catch (err) {
        console.error(err);
        res.render("signup", { error_message: "Error creating account. Username or Email might already be taken." });
    }
});

app.get("/donate", (req, res) => {
    if (req.session.isLoggedIn) {
        return res.redirect("/donations");
    }
    res.render("donate_public", { success_message: null });
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
        res.render("donate_public", { success_message: `Thank you, ${first_name}!` });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error processing donation.");
    }
});

// 2. Auth Routes
app.get("/login", (req, res) => res.render("login", { error_message: null }));

app.post("/login", async (req, res) => {
    try {
        const user = await db("users").where({ username: req.body.username }).first();
        if (user && user.password === req.body.password) {
            req.session.isLoggedIn = true;
            req.session.username = user.username;
            req.session.role = user.role;
            req.session.participantId = user.participant_id; 
            
            // --- NEW: FETCH PROFILE PICTURE ---
            if (user.participant_id) {
                const participant = await db("participants")
                    .select("profilePictureUrl") // Note the CamelCase column
                    .where({ participant_id: user.participant_id })
                    .first();
                req.session.profilePictureUrl = participant ? participant.profilePictureUrl : null;
            }
            // ----------------------------------

            req.session.save(() => res.redirect("/dashboard"));
        } else {
            res.render("login", { error_message: "Invalid credentials" });
        }
    } catch (err) {
        console.error(err);
        res.render("login", { error_message: "System Error" });
    }
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// 3. Dashboard
app.get("/dashboard", isLoggedIn, async (req, res) => {
    const hour = new Date().getHours();
    let greeting = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";
    let stats = { participants: 0, events: 0, donations: 0 };

    try {
        if (req.session.role === 'manager' || req.session.username === 'superuser') {
            const p = await db("participants").count("participant_id as count").first();
            const d = await db("donations").count("donation_id as count").first();
            const e = await db("event_occurrences").count("event_occurrence_id as count").first();
            stats = { participants: p.count, donations: d.count, events: e.count };
        } else {
            const myId = req.session.participantId;
            stats.participants = myId ? 1 : 0; 
            if (myId) {
                const d = await db("donations").where({ participant_id: myId }).count("donation_id as count").first();
                const e = await db("registrations").where({ participant_id: myId }).count("registration_id as count").first();
                stats.donations = d.count;
                stats.events = e.count;
            }
        }
    } catch (e) { console.error(e); }
    
    res.render("dashboard", { greeting, stats });
});

// 4. PARTICIPANTS
app.get("/participants", isLoggedIn, async (req, res) => {
    let query = db("participants").select("*").orderBy("participant_id");
    const searchQuery = req.query.q;

    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        query = query.where('participant_id', req.session.participantId);
    }

    if (searchQuery) {
        query = query.andWhere(builder => {
            builder.where('first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(first_name, ' ', last_name) ILIKE ?", [`%${searchQuery}%`])
                   .orWhere('email', 'ilike', `%${searchQuery}%`)
                   .orWhere('city', 'ilike', `%${searchQuery}%`);
        });
    }

    const participants = await query;
    res.render("participants", { 
        participants, 
        isManager: req.session.role === 'manager', 
        query: searchQuery 
    });
});

// --- UPLOAD IMAGE ROUTE (Updated) ---
app.post("/participants/upload-image", isLoggedIn, upload.single('profile_pic'), async (req, res) => {
    try {
        if (!req.file) {
            return res.redirect("/participants"); 
        }

        // Determine who we are updating:
        // 1. Default to the logged-in user
        let targetId = req.session.participantId;
        
        // 2. IF a manager sent a specific ID in the form, use that instead
        if (req.session.role === 'manager' && req.body.participant_id) {
            targetId = req.body.participant_id;
        }

        const s3Url = req.file.location;

        // Update Database
        await db("participants")
            .where({ participant_id: targetId })
            .update({ profilePictureUrl: s3Url });

        // Only update the SESSION profile pic if the user updated THEMSELVES
        if (parseInt(targetId) === req.session.participantId) {
            req.session.profilePictureUrl = s3Url;
            req.session.save(() => res.redirect("/participants"));
        } else {
            // If manager updated someone else, just redirect back
            res.redirect("/participants");
        }

    } catch (err) {
        console.error("Upload Error", err);
        res.status(500).send("Error uploading image");
    }
});

app.get("/participants/add", isManager, (req, res) => res.render("participants_add", { returnTo: req.query.returnTo }));
app.post("/participants/add", isManager, async (req, res) => {
    try {
        const [newP] = await db("participants").insert(req.body).returning('participant_id');
        if (req.body.returnTo === 'donations_add') res.redirect(`/donations/add?newParticipantId=${newP.participant_id}`);
        else res.redirect("/participants");
    } catch (err) { console.error(err); res.status(500).send("Error adding participant"); }
});
app.get("/participants/edit/:id", isManager, async (req, res) => {
    const participant = await db("participants").where({ participant_id: req.params.id }).first();
    res.render("participants_edit", { participant });
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

// 5. DONATIONS
app.get("/donations", isLoggedIn, async (req, res) => {
    let query = db("donations")
        .join("participants", "donations.participant_id", "participants.participant_id")
        .select("donations.*", "participants.first_name", "participants.last_name")
        .orderBy("donations.donation_date", "desc");
    const searchQuery = req.query.q;

    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        query = query.where('donations.participant_id', req.session.participantId);
    }

    if (searchQuery) {
        query = query.andWhere(builder => {
            builder.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`]);
            if (!isNaN(searchQuery)) {
                builder.orWhere('donation_amount', '=', searchQuery);
            }
        });
    }

    const donations = await query;
    res.render("donations", { 
        donations, 
        isManager: req.session.role === 'manager', 
        query: searchQuery 
    });
});

app.get("/donations/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("donations_add", { participants, newParticipantId: req.query.newParticipantId });
});
app.post("/donations/add", isManager, async (req, res) => {
    await db("donations").insert({ participant_id: req.body.participant_id, donation_date: req.body.donation_date, donation_amount: req.body.donation_amount });
    res.redirect("/donations");
});
app.get("/donations/edit/:id", isManager, async (req, res) => {
    const donation = await db("donations").where({ donation_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("donations_edit", { donation, participants });
});
app.post("/donations/edit/:id", isManager, async (req, res) => {
    await db("donations").where({ donation_id: req.params.id }).update({ participant_id: req.body.participant_id, donation_date: req.body.donation_date, donation_amount: req.body.donation_amount });
    res.redirect("/donations");
});
app.post("/donations/delete/:id", isManager, async (req, res) => {
    await db("donations").where({ donation_id: req.params.id }).del();
    res.redirect("/donations");
});

// 6. SURVEYS
app.get("/surveys", isLoggedIn, async (req, res) => {
    let query = db("surveys")
        .join("participants", "surveys.participant_id", "participants.participant_id")
        .join("event_occurrences", "surveys.event_occurrence_id", "event_occurrences.event_occurrence_id")
        .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
        .select("surveys.*", "participants.first_name", "participants.last_name", "event_templates.event_name", "event_occurrences.start_time")
        .orderBy("surveys.submission_date", "desc");
    const searchQuery = req.query.q;

    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        query = query.where('surveys.participant_id', req.session.participantId);
    }

    if (searchQuery) {
        query = query.andWhere(builder => {
            builder.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`])
                   .orWhere('event_templates.event_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('surveys.comments', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("TO_CHAR(surveys.submission_date, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(surveys.submission_date, 'fmMM/fmDD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(surveys.submission_date, 'YYYY-MM-DD') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'fmMM/fmDD/YYYY') ILIKE ?", [`%${searchQuery}%`]);
        });
    }

    const surveys = await query;
    res.render("surveys", { 
        surveys, 
        isManager: req.session.role === 'manager', 
        query: searchQuery 
    });
});

app.get("/surveys/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const events = await db("event_occurrences").join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id").select("event_occurrences.event_occurrence_id", "event_templates.event_name", "event_occurrences.start_time").orderBy("event_occurrences.start_time", "desc");
    const npsBuckets = await db("nps_buckets").select("*");
    res.render("surveys_add", { participants, events, npsBuckets });
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
    res.render("surveys_edit", { survey, participants, events, npsBuckets });
});
app.post("/surveys/edit/:id", isManager, async (req, res) => {
    await db("surveys").where({ survey_id: req.params.id }).update(req.body);
    res.redirect("/surveys");
});
app.post("/surveys/delete/:id", isManager, async (req, res) => {
    await db("surveys").where({ survey_id: req.params.id }).del();
    res.redirect("/surveys");
});

// 7. EVENTS
app.get("/events", isLoggedIn, async (req, res) => {
    let query = db("event_occurrences")
        .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
        .join("locations", "event_occurrences.location_id", "locations.location_id")
        .select("event_occurrences.*", "event_templates.event_name", "event_templates.event_description", "locations.location_name")
        .orderBy("event_occurrences.start_time", "desc");
    const searchQuery = req.query.q;

    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        query = query.join("registrations", "event_occurrences.event_occurrence_id", "registrations.event_occurrence_id")
                     .where("registrations.participant_id", req.session.participantId);
    }

    if (searchQuery) {
        query = query.andWhere(builder => {
            builder.where('event_templates.event_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('locations.location_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'fmMM/fmDD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'MM-DD-YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'Month') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(event_occurrences.start_time, 'YYYY-MM-DD') ILIKE ?", [`%${searchQuery}%`]);
        });
    }

    const events = await query;
    res.render("events", { 
        events, 
        isManager: req.session.role === 'manager', 
        query: searchQuery 
    });
});
app.get("/events/add", isManager, async (req, res) => {
    const templates = await db("event_templates").select("*");
    const locations = await db("locations").select("*");
    res.render("events_add", { templates, locations });
});
app.post("/events/add", isManager, async (req, res) => {
    await db("event_occurrences").insert(req.body);
    res.redirect("/events");
});
app.get("/events/edit/:id", isManager, async (req, res) => {
    const event = await db("event_occurrences").where({ event_occurrence_id: req.params.id }).first();
    const templates = await db("event_templates").select("*");
    const locations = await db("locations").select("*");
    res.render("events_edit", { event, templates, locations });
});
app.post("/events/edit/:id", isManager, async (req, res) => {
    await db("event_occurrences").where({ event_occurrence_id: req.params.id }).update(req.body);
    res.redirect("/events");
});
app.post("/events/delete/:id", isManager, async (req, res) => {
    await db("event_occurrences").where({ event_occurrence_id: req.params.id }).del();
    res.redirect("/events");
});

// 8. MILESTONES
app.get("/milestones", isLoggedIn, async (req, res) => {
    let query = db("milestones")
        .join("participants", "milestones.participant_id", "participants.participant_id")
        .join("milestone_types", "milestones.milestone_type_id", "milestone_types.milestone_type_id")
        .select("milestones.*", "participants.first_name", "participants.last_name", "milestone_types.milestone_title")
        .orderBy("milestones.milestone_date", "desc");
    const searchQuery = req.query.q;

    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        query = query.where('milestones.participant_id', req.session.participantId);
    }

    if (searchQuery) {
        query = query.andWhere(builder => {
            builder.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`])
                   .orWhere('milestone_types.milestone_title', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'fmMM/fmDD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'MM-DD-YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'Month') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'YYYY-MM-DD') ILIKE ?", [`%${searchQuery}%`]);
        });
    }

    const milestones = await query;
    res.render("milestones", { 
        milestones, 
        isManager: req.session.role === 'manager', 
        query: searchQuery 
    });
});
app.get("/milestones/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const types = await db("milestone_types").select("*");
    res.render("milestones_add", { participants, types });
});
app.post("/milestones/add", isManager, async (req, res) => {
    await db("milestones").insert(req.body);
    res.redirect("/milestones");
});
app.get("/milestones/edit/:id", isManager, async (req, res) => {
    const milestone = await db("milestones").where({ milestone_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const types = await db("milestone_types").select("*");
    res.render("milestones_edit", { milestone, participants, types });
});
app.post("/milestones/edit/:id", isManager, async (req, res) => {
    await db("milestones").where({ milestone_id: req.params.id }).update(req.body);
    res.redirect("/milestones");
});
app.post("/milestones/delete/:id", isManager, async (req, res) => {
    await db("milestones").where({ milestone_id: req.params.id }).del();
    res.redirect("/milestones");
});

// 9. USER MANAGEMENT
app.get("/users", isManager, async (req, res) => {
    try {
        let query = db("users")
            .leftJoin("participants", "users.participant_id", "participants.participant_id")
            .select("users.*", "participants.first_name", "participants.last_name")
            .orderBy("users.user_id");
        
        const searchQuery = req.query.q;
        if (searchQuery) {
            query = query.where(builder => {
                builder.where('users.username', 'ilike', `%${searchQuery}%`)
                       .orWhere('users.role', 'ilike', `%${searchQuery}%`)
                       .orWhere('participants.first_name', 'ilike', `%${searchQuery}%`)
                       .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                       .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`]);
            });
        }

        const users = await query;
        res.render("users", { 
            users, 
            role: req.session.role,
            query: searchQuery 
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error retrieving users"); 
    }
});
app.get("/users/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("users_add", { participants });
});
app.post("/users/add", isManager, async (req, res) => {
    await db("users").insert({ username: req.body.username, password: req.body.password, role: req.body.role, participant_id: req.body.participant_id || null });
    res.redirect("/users");
});
app.get("/users/edit/:id", isManager, async (req, res) => {
    const userToEdit = await db("users").where({ user_id: req.params.id }).first();
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    res.render("users_edit", { userToEdit, participants });
});
app.post("/users/edit/:id", isManager, async (req, res) => {
    await db("users").where({ user_id: req.params.id }).update({ username: req.body.username, password: req.body.password, role: req.body.role, participant_id: req.body.participant_id || null });
    res.redirect("/users");
});
app.post("/users/delete/:id", isManager, async (req, res) => {
    if (parseInt(req.params.id) === req.session.user_id) return res.status(400).send("Cannot delete self."); 
    await db("users").where({ user_id: req.params.id }).del();
    res.redirect("/users");
});

// Teapot
app.get("/teapot", isLoggedIn, (req, res) => res.status(418).render("teapot"));

app.listen(PORT, () => console.log(`Ella Rises running on port ${PORT}`));