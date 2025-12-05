// Spencer Jorgensen, Broc Cuartas, Brandon Wood, Josh Clarke
// Ella Rises Backend Application
// This is the main engine for our website. It sets up the server, connects to our PostgreSQL database,
// and handles all the traffic—like users logging in, managers updating events, and participants
// filling out surveys. It also connects to AWS S3 so we can store profile pictures in the cloud.

// First, we import all the tools we need to make the app work.
import express from "express";
import knex from "knex";
import path from "path";
import { fileURLToPath } from "url";
// We load our secret keys (like database passwords) from the .env file so they stay safe.
import 'dotenv/config'; 
import session from "express-session";

// These tools let us accept file uploads and send them to Amazon S3.
import { S3Client } from "@aws-sdk/client-s3";
import multer from "multer";
import multerS3 from "multer-s3";

// Since we are using modules, we need to manually figure out where our files live on the computer.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Now we start up the Express server and pick a port (usually 3000).
const app = express();
const PORT = process.env.PORT || 3000;

// Here we set up the basics: we tell Express to use EJS for templates and where to find our files.
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
// This line lets us read data from forms when users hit "Submit".
app.use(express.urlencoded({ extended: true }));

// This connects our app to the actual database using the settings we saved in our environment variables.
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

// We need sessions to remember who is logged in as they click around the site.
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// This sets up our connection to AWS S3 for storing images.
const s3 = new S3Client({
    region: process.env.AWS_REGION ? process.env.AWS_REGION.trim() : "us-east-2",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ? process.env.AWS_ACCESS_KEY_ID.trim() : "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ? process.env.AWS_SECRET_ACCESS_KEY.trim() : ""
    }
});

// This tells the uploader exactly how to save files: put them in our bucket and give them a unique name with a timestamp.
const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET_NAME ? process.env.S3_BUCKET_NAME.trim() : "ella-rises-uploads",
        acl: 'public-read',
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            cb(null, `profile-pics/${Date.now().toString()}-${file.originalname}`);
        }
    })
});

// --- HELPER FUNCTIONS (MIDDLEWARE) ---

// This gatekeeper checks if a person is logged in. If not, we bounce them to the login page.
const isLoggedIn = (req, res, next) => {
    if (req.session.isLoggedIn) next();
    else res.redirect('/login');
};

// This gatekeeper is stricter: it only lets Managers or Superusers through.
const isManager = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'manager') next();
    else res.status(403).send("Access Denied: Managers only.");
};

// This runs on every single request to make sure our views always know who is logged in.
// It saves us from having to pass "user: req.session.username" into every res.render call manually.
app.use(async (req, res, next) => {
    res.locals.isLoggedIn = req.session.isLoggedIn || false;
    res.locals.user = req.session.username || null;
    res.locals.role = req.session.role || null;
    res.locals.userProfilePic = req.session.profilePictureUrl || null;
    next();
});


// --- WEBSITE ROUTES ---

// The home page that everyone sees first.
app.get("/", (req, res) => {
    res.render("landing");
});

// This shows the form where new people can create an account.
app.get("/signup", (req, res) => {
    res.render("signup", { error_message: null });
});

// When someone fills out the signup form, this logic creates their account.
// It creates a "Participant" record first, then links a "User" login to it.
app.post("/signup", async (req, res) => {
    const { username, password, first_name, last_name, email } = req.body;
    try {
        const [newPerson] = await db("participants").insert({
            first_name,
            last_name,
            email
        }).returning('participant_id');

        await db("users").insert({
            username,
            password,
            role: 'user', // Everyone starts as a normal user
            participant_id: newPerson.participant_id
        });

        // We log them in automatically so they don't have to type their password again immediately.
        req.session.isLoggedIn = true;
        req.session.username = username;
        req.session.role = 'user';
        req.session.participantId = newPerson.participant_id;
        
        // Normal users go straight to their events page.
        req.session.save(() => res.redirect("/events"));

    } catch (err) {
        console.error(err);
        res.render("signup", { error_message: "Error creating account. Username or Email might already be taken." });
    }
});

// This shows the donation page. If a user is already logged in, we try to pre-fill their name for convenience.
app.get("/donate", async (req, res) => {
    let participant = null;

    if (req.session.isLoggedIn && req.session.participantId) {
        try {
            participant = await db("participants")
                .where({ participant_id: req.session.participantId })
                .first();
        } catch (err) {
            console.error("Error fetching participant for donation:", err);
        }
    }

    res.render("donate_public", { 
        success_message: null,
        participant: participant
    });
});

// This handles the actual money part (simulated) and records the donation in our database.
app.post("/donate", async (req, res) => {
    const { first_name, last_name, email, donation_amount } = req.body;
    try {
        let participantId;
        // We check if we already know this person by their email.
        const existing = await db("participants").where({ email }).first();
        if (existing) {
            participantId = existing.participant_id;
        } else {
            // If they are new, we create a basic participant record for them.
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

// Shows the login screen.
app.get("/login", (req, res) => res.render("login", { error_message: null }));

// This checks if the username and password match what's in our database.
app.post("/login", async (req, res) => {
    try {
        const user = await db("users").where({ username: req.body.username }).first();
        if (user && user.password === req.body.password) {
            // Success! Set up their session.
            req.session.isLoggedIn = true;
            req.session.username = user.username;
            req.session.role = user.role;
            req.session.participantId = user.participant_id; 
            
            // If they have a profile picture, grab it now so we can show it in the navbar.
            if (user.participant_id) {
                const participant = await db("participants")
                    .select("profilePictureUrl")
                    .where({ participant_id: user.participant_id })
                    .first();
                req.session.profilePictureUrl = participant ? participant.profilePictureUrl : null;
            }

            // Direct Managers to the Dashboard, and everyone else to Events.
            req.session.save(() => {
                if (user.role === 'manager' || user.username === 'superuser') {
                    res.redirect("/dashboard");
                } else {
                    res.redirect("/events");
                }
            });

        } else {
            res.render("login", { error_message: "Invalid credentials" });
        }
    } catch (err) {
        console.error(err);
        res.render("login", { error_message: "System Error" });
    }
});

// This kills the session to log the user out safely.
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// The Manager Dashboard - shows high-level stats and charts
app.get("/dashboard", isLoggedIn, async (req, res) => {
    if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
        return res.redirect("/events");
    }

    // A nice touch: we check the time to say Good Morning, Afternoon, or Evening.
    const hour = new Date().getHours();
    let greeting = "Good Morning";
    
    if (hour >= 12 && hour < 17) {
        greeting = "Good Afternoon";
    } else if (hour >= 17) {
        greeting = "Good Evening";
    }

    // Ensure the name looks nice (Capitalized)
    let displayUser = req.session.username;
    if (displayUser) {
        displayUser = displayUser.charAt(0).toUpperCase() + displayUser.slice(1);
    }

    // Grab some quick numbers for the top cards
    let stats = { participants: 0, events: 0, donations: 0 };
    try {
        const p = await db("participants").count("participant_id as count").first();
        const d = await db("donations").count("donation_id as count").first();
        const e = await db("event_occurrences").count("event_occurrence_id as count").first();
        stats = { participants: p.count, donations: d.count, events: e.count };
    } catch (e) { console.error(e); }
    
    res.render("dashboard", { greeting, user: displayUser, stats });
});

// This route lists all the participants. It handles search and pagination to keep things fast.
app.get("/participants", isLoggedIn, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 100; // Only show 100 people at a time
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q;

    // We use this function to apply search filters to both the Counter and the Data Fetcher
    const applyFilters = (builder) => {
        // Regular users can only see themselves
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            builder.where('participant_id', req.session.participantId);
        }
        // If there's a search term, check names, emails, and cities
        if (searchQuery) {
            builder.andWhere(subBuilder => {
                subBuilder.where('first_name', 'ilike', `%${searchQuery}%`)
                       .orWhere('last_name', 'ilike', `%${searchQuery}%`)
                       .orWhereRaw("CONCAT(first_name, ' ', last_name) ILIKE ?", [`%${searchQuery}%`])
                       .orWhere('email', 'ilike', `%${searchQuery}%`)
                       .orWhere('city', 'ilike', `%${searchQuery}%`);
            });
        }
    };

    try {
        // Step 1: Count how many total results match the search
        const countQuery = db("participants").count("participant_id as count").first();
        applyFilters(countQuery);
        const countResult = await countQuery;
        const totalCount = parseInt(countResult.count);
        const totalPages = Math.ceil(totalCount / limit);

        // Step 2: Get the actual slice of data for the current page
        const dataQuery = db("participants").select("*").orderBy("participant_id").limit(limit).offset(offset);
        applyFilters(dataQuery);
        const participants = await dataQuery;

        res.render("participants", { 
            participants, 
            isManager: req.session.role === 'manager', 
            query: searchQuery,
            currentPage: page,
            totalPages: totalPages
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching participants");
    }
});

// This receives a file from the form and sends it to AWS S3.
app.post("/participants/upload-image", isLoggedIn, upload.single('profile_pic'), async (req, res) => {
    try {
        if (!req.file) {
            return res.redirect("/participants"); 
        }

        let targetId = req.session.participantId;
        // Allow managers to upload photos for other people
        if (req.session.role === 'manager' && req.body.participant_id) {
            targetId = req.body.participant_id;
        }

        const s3Url = req.file.location;

        // Save the new URL to the database
        await db("participants")
            .where({ participant_id: targetId })
            .update({ profilePictureUrl: s3Url });

        // If the user updated their own photo, update their session immediately so the navbar refreshes
        if (parseInt(targetId) === req.session.participantId) {
            req.session.profilePictureUrl = s3Url;
            req.session.save(() => res.redirect("/participants"));
        } else {
            res.redirect("/participants");
        }

    } catch (err) {
        console.error("Upload Error", err);
        res.status(500).send("Error uploading image");
    }
});

// This removes a profile photo by setting the database field back to null.
app.post("/participants/delete-image", isLoggedIn, async (req, res) => {
    try {
        let targetId = req.session.participantId;
        if (req.session.role === 'manager' && req.body.participant_id) {
            targetId = req.body.participant_id;
        }

        await db("participants")
            .where({ participant_id: targetId })
            .update({ profilePictureUrl: null });

        if (parseInt(targetId) === req.session.participantId) {
            req.session.profilePictureUrl = null;
            req.session.save(() => res.redirect("/participants"));
        } else {
            res.redirect("/participants");
        }

    } catch (err) {
        console.error("Delete Error", err);
        res.status(500).send("Error deleting image");
    }
});

// --- PARTICIPANT CRUD ROUTES (Create, Read, Update, Delete) ---

app.get("/participants/add", isManager, (req, res) => res.render("participants_add", { returnTo: req.query.returnTo }));

app.post("/participants/add", isManager, async (req, res) => {
    try {
        // ERROR FIX: Separate 'returnTo' from the rest of the form data
        // We cannot just insert 'req.body' because 'returnTo' is not a column in the database.
        const { returnTo, ...participantData } = req.body;

        const [newP] = await db("participants").insert(participantData).returning('participant_id');
        
        // If we came from the donation page, send us back there to finish the donation
        if (returnTo === 'donations_add') {
            res.redirect(`/donations/add?newParticipantId=${newP.participant_id}`);
        } else {
            res.redirect("/participants");
        }
    } catch (err) { 
        console.error(err); 
        res.status(500).send("Error adding participant"); 
    }
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

// This allows a manager to delete a person. It performs a "Cascade Delete" manually,
// wiping out all their history (donations, surveys, etc.) before deleting the person record.
app.post("/participants/delete/:id", isManager, async (req, res) => {
    const targetId = req.params.id;
    try {
        await db.transaction(async (trx) => {
            // Clean up all related tables first
            await trx("donations").where({ participant_id: targetId }).del();
            await trx("surveys").where({ participant_id: targetId }).del();
            await trx("registrations").where({ participant_id: targetId }).del();
            await trx("milestones").where({ participant_id: targetId }).del();
            await trx("users").where({ participant_id: targetId }).del();

            // Safe to delete the participant now
            await trx("participants").where({ participant_id: targetId }).del();
        });
        res.redirect("/participants");
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).send("Error deleting participant.");
    }
});

// Shows the donation history table with pagination.
app.get("/donations", isLoggedIn, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 100;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q;

    // Filter logic for donations (by name, amount, or date)
    const applyFilters = (builder) => {
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            builder.where('donations.participant_id', req.session.participantId);
        }
        if (searchQuery) {
            builder.andWhere(sub => {
                sub.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`]);
                
                if (!isNaN(searchQuery)) {
                    sub.orWhere('donation_amount', '=', searchQuery);
                }
                sub.orWhereRaw("TO_CHAR(donations.donation_date, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(donations.donation_date, 'YYYY-MM-DD') ILIKE ?", [`%${searchQuery}%`])
                   .orWhereRaw("TO_CHAR(donations.donation_date, 'Month') ILIKE ?", [`%${searchQuery}%`]);
            });
        }
    };

    try {
        // Pagination Count
        const countQuery = db("donations")
            .join("participants", "donations.participant_id", "participants.participant_id")
            .count("donations.donation_id as count").first();
        applyFilters(countQuery);
        const countResult = await countQuery;
        const totalPages = Math.ceil(parseInt(countResult.count) / limit);

        // Data Fetch
        const dataQuery = db("donations")
            .join("participants", "donations.participant_id", "participants.participant_id")
            .select("donations.*", "participants.first_name", "participants.last_name")
            .orderBy("donations.donation_date", "desc")
            .limit(limit)
            .offset(offset);
        applyFilters(dataQuery);
        const donations = await dataQuery;

        res.render("donations", { 
            donations, 
            isManager: req.session.role === 'manager', 
            query: searchQuery,
            currentPage: page,
            totalPages: totalPages
        });
    } catch(e) { console.error(e); res.status(500).send("Error"); }
});

// Donation CRUD routes
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

// Displays the survey form for a specific event
app.get("/survey/:eventId", isLoggedIn, (req, res) => {
    res.render("survey", { eventId: req.params.eventId });
});

// Lets a user or manager view a past survey response
app.get("/survey/view/:surveyId", isLoggedIn, async (req, res) => {
    try {
        const survey = await db("surveys")
            .where({ survey_id: req.params.surveyId })
            .first();

        if (!survey) {
            return res.redirect("/events");
        }

        // Security check: You can only see your own survey (unless you're a manager)
        if (req.session.role !== 'manager' && survey.participant_id !== req.session.participantId) {
            return res.status(403).send("You are not authorized to view this survey.");
        }

        const source = req.query.source || 'events';
        res.render("survey_view", { survey, source });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error viewing survey");
    }
});

// Saves a new survey response
app.post("/submit-survey", isLoggedIn, async (req, res) => {
    const userId = req.session.participantId;
    const { 
        event_id, satisfaction, usefulness, instructor, recommend, overall, comments 
    } = req.body;

    try {
        // Double check they haven't already submitted this survey
        const existing = await db("surveys")
            .where({ participant_id: userId, event_occurrence_id: event_id }).first();

        if (existing) {
            return res.redirect("/events");
        }

        // Calculate the NPS Bucket based on the recommend score (1-5)
        let npsBucketId;
        const recScore = parseInt(recommend);

        if (recScore >= 1 && recScore <= 3) npsBucketId = 1; // Detractor
        else if (recScore === 4) npsBucketId = 2; // Passive
        else if (recScore === 5) npsBucketId = 3; // Promoter
        else npsBucketId = null;

        await db("surveys").insert({
            participant_id: userId,
            event_occurrence_id: event_id,
            score_satisfaction: satisfaction,
            score_usefulness: usefulness,
            score_instructor: instructor,
            score_recommendation: recommend,
            score_overall: overall,
            nps_bucket_id: npsBucketId,
            comments: comments,
            submission_date: new Date()
        });

        res.redirect("/events");
    } catch (err) {
        console.error("Error submitting survey", err);
        res.status(500).send("Error submitting survey: " + err.message);
    }
});

// Lists all survey responses with search and pagination
app.get("/surveys", isLoggedIn, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 100;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q;

    const applyFilters = (builder) => {
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            builder.where('surveys.participant_id', req.session.participantId);
        }
        if (searchQuery) {
            builder.andWhere(sub => {
                sub.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('participants.last_name', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("CONCAT(participants.first_name, ' ', participants.last_name) ILIKE ?", [`%${searchQuery}%`])
                   .orWhere('event_templates.event_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('surveys.comments', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("TO_CHAR(surveys.submission_date, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`]);
            });
        }
    };

    try {
        // Get counts first
        const countQuery = db("surveys")
            .join("participants", "surveys.participant_id", "participants.participant_id")
            .join("event_occurrences", "surveys.event_occurrence_id", "event_occurrences.event_occurrence_id")
            .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
            .count("surveys.survey_id as count").first();
        applyFilters(countQuery);
        const countResult = await countQuery;
        const totalPages = Math.ceil(parseInt(countResult.count) / limit);

        // Get data
        const dataQuery = db("surveys")
            .join("participants", "surveys.participant_id", "participants.participant_id")
            .join("event_occurrences", "surveys.event_occurrence_id", "event_occurrences.event_occurrence_id")
            .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
            .select("surveys.*", "participants.first_name", "participants.last_name", "event_templates.event_name", "event_occurrences.start_time")
            .orderBy("surveys.submission_date", "desc")
            .limit(limit)
            .offset(offset);
        applyFilters(dataQuery);
        const surveys = await dataQuery;

        res.render("surveys", { 
            surveys, 
            isManager: req.session.role === 'manager', 
            query: searchQuery,
            currentPage: page,
            totalPages: totalPages
        });
    } catch(e) { console.error(e); res.status(500).send("Error"); }
});

// Survey CRUD routes
app.get("/surveys/add", isManager, async (req, res) => {
    const participants = await db("participants").select("participant_id", "first_name", "last_name").orderBy("last_name");
    const events = await db("event_occurrences").join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id").select("event_occurrences.event_occurrence_id", "event_templates.event_name", "event_occurrences.start_time").orderBy("event_occurrences.start_time", "desc");
    res.render("surveys_add", { participants, events });
});

app.post("/surveys/add", isManager, async (req, res) => {
    const { 
        participant_id, event_occurrence_id, 
        score_satisfaction, score_usefulness, score_instructor, 
        score_recommendation, score_overall, comments 
    } = req.body;

    try {
        let npsBucketId;
        const recScore = parseInt(score_recommendation);

        if (recScore >= 1 && recScore <= 3) {
            npsBucketId = 1; // Detractor
        } else if (recScore === 4) {
            npsBucketId = 2; // Passive
        } else if (recScore === 5) {
            npsBucketId = 3; // Promoter
        } else {
            npsBucketId = null; 
        }

        await db("surveys").insert({
            participant_id,
            event_occurrence_id,
            score_satisfaction,
            score_usefulness,
            score_instructor,
            score_recommendation,
            score_overall,
            nps_bucket_id: npsBucketId, 
            comments,
            submission_date: new Date()
        });

        res.redirect("/surveys");
    } catch (err) {
        console.error("Error adding survey manually", err);
        res.status(500).send("Error saving survey");
    }
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

// Lists events with pagination. For users, it also checks if they have completed feedback.
app.get("/events", isLoggedIn, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 100;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q;

    const applyFilters = (builder) => {
        if (searchQuery) {
            builder.andWhere(sub => {
                sub.where('event_templates.event_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('locations.location_name', 'ilike', `%${searchQuery}%`);
                // (Date filters omitted for brevity in comment, but they exist here)
                sub.orWhereRaw("TO_CHAR(event_occurrences.start_time, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`]);
            });
        }
    };

    try {
        let baseQuery = db("event_occurrences")
            .join("event_templates", "event_occurrences.event_template_id", "event_templates.event_template_id")
            .join("locations", "event_occurrences.location_id", "locations.location_id");

        // If regular user, check which events they have done survey for
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            const participantId = req.session.participantId;
            baseQuery = baseQuery.join("registrations", "event_occurrences.event_occurrence_id", "registrations.event_occurrence_id")
                         .where("registrations.participant_id", participantId)
                         .leftJoin("surveys", function() {
                             this.on("event_occurrences.event_occurrence_id", "=", "surveys.event_occurrence_id")
                                 .andOn("surveys.participant_id", "=", db.raw("?", [participantId]));
                         });
        }

        // Get total pages
        const countQuery = baseQuery.clone().count('event_occurrences.event_occurrence_id as count').first();
        applyFilters(countQuery);
        const countResult = await countQuery;
        const totalPages = Math.ceil(parseInt(countResult.count) / limit);

        // Get events
        let dataQuery = baseQuery
            .select("event_occurrences.*", "event_templates.event_name", "event_templates.event_description", "locations.location_name")
            .orderBy("event_occurrences.start_time", "desc")
            .limit(limit)
            .offset(offset);
        
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            dataQuery = dataQuery.select("surveys.survey_id");
        }
        applyFilters(dataQuery);
        const events = await dataQuery;

        res.render("events", { 
            events, 
            isManager: req.session.role === 'manager', 
            query: searchQuery,
            currentPage: page,
            totalPages: totalPages
        });
    } catch(e) { console.error(e); res.status(500).send("Error"); }
});

// Event CRUD routes
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

// Lists milestones with pagination
app.get("/milestones", isLoggedIn, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 100;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q;

    const applyFilters = (builder) => {
        if (req.session.role !== 'manager' && req.session.username !== 'superuser') {
            builder.where('milestones.participant_id', req.session.participantId);
        }
        if (searchQuery) {
            builder.andWhere(sub => {
                sub.where('participants.first_name', 'ilike', `%${searchQuery}%`)
                   .orWhere('milestone_types.milestone_title', 'ilike', `%${searchQuery}%`)
                   .orWhereRaw("TO_CHAR(milestones.milestone_date, 'MM/DD/YYYY') ILIKE ?", [`%${searchQuery}%`]);
            });
        }
    };

    try {
        const countQuery = db("milestones")
            .join("participants", "milestones.participant_id", "participants.participant_id")
            .join("milestone_types", "milestones.milestone_type_id", "milestone_types.milestone_type_id")
            .count("milestones.milestone_id as count").first();
        applyFilters(countQuery);
        const countResult = await countQuery;
        const totalPages = Math.ceil(parseInt(countResult.count) / limit);

        const dataQuery = db("milestones")
            .join("participants", "milestones.participant_id", "participants.participant_id")
            .join("milestone_types", "milestones.milestone_type_id", "milestone_types.milestone_type_id")
            .select("milestones.*", "participants.first_name", "participants.last_name", "milestone_types.milestone_title")
            .orderBy("milestones.milestone_date", "desc")
            .limit(limit)
            .offset(offset);
        applyFilters(dataQuery);
        const milestones = await dataQuery;

        res.render("milestones", { 
            milestones, 
            isManager: req.session.role === 'manager', 
            query: searchQuery,
            currentPage: page,
            totalPages: totalPages
        });
    } catch(e) { console.error(e); res.status(500).send("Error"); }
});

// Milestone management routes
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

// Allows managers to create and edit user login accounts
app.get("/users", isManager, async (req, res) => {
    try {
        let query = db("users")
            .leftJoin("participants", "users.participant_id", "participants.participant_id")
            .select("users.*", "participants.first_name", "participants.last_name")
            .orderBy("users.user_id");
        
        const searchQuery = req.query.q;
        if (searchQuery) {
            query = query.where(builder => {
                builder.where('users.username', 'ilike', `%${searchQuery}%`);
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

// A fun little "I'm a teapot" route for testing or curiosity
app.get("/teapot", isLoggedIn, (req, res) => res.status(418).render("teapot"));

// Start the server and listen for requests
app.listen(PORT, () => console.log(`Ella Rises running on port ${PORT}`));