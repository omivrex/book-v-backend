require("dotenv").config();
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import * as admin from "firebase-admin";
import jwt from "jsonwebtoken";

// Initialize Firebase Admin SDK with your service account
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH as string);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = 3000;
const secretKey: string = process.env.JWT_SECRET_KEY as string; // Replace with your own secret key for JWT

app.use(bodyParser.json());

interface SignupData extends UserData {
    password: string;
}

interface UserData {
    email: string;
    accountType: "VENDOR" | "USER";
    fullName: string;
    businessName: string;
    location: LocationDataType | null;
    phone: string;
    password: string;
}

interface LocationDataType {
    long: number;
    lat: number;
    name: string;
}

// Extend Request type to include userId property
declare global {
    namespace Express {
        interface Request {
            userId?: string;
        }
    }
}

// Register a new user
app.post("/api/register", async (req: Request, res: Response) => {
    try {
        const { email, accountType, fullName, location, phone, password } = req.body as SignupData;
        const userRecord = await admin.auth().createUser({
            email,
            password,
        });

        const userData: any = {
            email,
            accountType,
            fullName,
            phone,
            location,
        };

        await admin.firestore().collection("users").doc(userRecord.uid).set(userData);

        // Return success message and access token
        const accessToken = jwt.sign({ uid: userRecord.uid }, secretKey, { expiresIn: "7d" });
        res.status(200).json({ message: "User registered successfully!", accessToken, data: userData });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Login user
app.post("/api/login", async (req: Request, res: Response) => {
    try {
        const { idToken } = req.body;
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const { uid } = decodedToken;

        // Custom logic to retrieve user data from Firestore if needed
        const userData = await admin.firestore().collection("users").doc(uid).get();

        // Generate JWT token for authenticated user
        const accessToken = jwt.sign({ uid }, secretKey, { expiresIn: "7d" });
        res.status(200).json({ message: "User logged in successfully", accessToken, data: userData.data() });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Middleware to verify JWT token
const verifyToken = (req: Request, res: Response, next: any) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Unauthorized" });
    jwt.verify(token, secretKey, (err: any, decoded: any) => {
        console.log("access token error", err);
        if (err) return res.status(403).json({ message: "Forbidden" });
        req.userId = decoded.uid;
        next();
    });
};

// Update user information
app.put("/api/update", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const updateData: UserData = req.body;

        // Check if any field is provided for update
        if (Object.values(updateData).filter(Boolean).length === 0) {
            return res.status(400).json({ message: "At least one field is required for update" });
        }

        // Update user information in Firestore
        await admin
            .firestore()
            .collection("users")
            .doc(userId)
            .update({ ...updateData });
        const userData = await admin.firestore().collection("users").doc(userId).get();

        res.status(200).json({ message: "User information updated successfully", data: userData.data() });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Create availability
app.post("/api/availability", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const { date, availability } = req.body;

        // Check if availability for the date already exists
        const docRef = admin.firestore().collection("users").doc(userId).collection("availability").doc(date);
        const doc = await docRef.get();

        if (doc.exists) {
            // Availability for the date already exists, append to existing array
            await docRef.update({
                availability: admin.firestore.FieldValue.arrayUnion(availability),
            });
        } else {
            // Availability for the date doesn't exist, create new document with array
            await docRef.set({
                availability: [availability],
            });
        }
        await addNotification(userId, "create", `New availability created for ${date}`);

        res.status(200).json({ message: "Availability added successfully" });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Get availability for a specific date
app.get("/api/availability/:date", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const date = req.params.date;

        // Get availability from Firestore subcollection
        const snapshot = await admin.firestore().collection("users").doc(userId).collection("availability").doc(date).get();
        const data = snapshot.data();
        const availability = data ? data.availability : [];

        res.status(200).json({ data: availability });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Update availability for a specific date
app.put("/api/availability/:date", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const date = req.params.date;
        const index = parseInt(req.query.index as string);
        const { availability } = req.body;

        // Update the availability at the specified index for the date in Firestore subcollection
        const docRef = admin.firestore().collection("users").doc(userId).collection("availability").doc(date);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: "Availability for the specified date not found" });
        }

        const existingAvailability = doc.data()?.availability || [];
        if (index < 0 || index >= existingAvailability.length) {
            return res.status(400).json({ message: "Invalid index provided" });
        }
        existingAvailability[index] = availability;

        await docRef.update({ availability: existingAvailability });
        await addNotification(userId, "update", `Availability updated for ${date}`);
        res.status(200).json({ message: "Availability updated successfully" });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Delete a single availability on a particular date
app.delete("/api/availability/delete/:date", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const date = req.params.date;
        const availabilityId = parseInt(req.query.availabilityId as string);

        // Construct the reference to the availability document
        const availabilityRef = admin.firestore().collection("users").doc(userId).collection("availability").doc(date);

        // Get the availability document
        const availabilitySnapshot = await availabilityRef.get();

        // Check if the availability document exists
        if (!availabilitySnapshot.exists) {
            return res.status(404).json({ message: "Availability for the specified date not found" });
        }

        // Get the current availability array
        const currentAvailability: any[] = availabilitySnapshot.data()?.availability || [];

        // Remove the specified availability from the array
        const updatedAvailability = currentAvailability.filter((avail, index) => index !== availabilityId);
        // Update the availability document with the modified array
        await availabilityRef.update({ availability: updatedAvailability });
        await addNotification(userId, "delete", `Availability deleted for ${date}`);
        return res.status(200).json({ message: "Availability deleted successfully" });
    } catch (error) {
        return res.status(400).json({ message: (error as Error).message });
    }
});

// Delete all availability for a specific date
app.delete("/api/availability/:date", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;
        const date = req.params.date;

        // Delete availability from Firestore subcollection
        await admin.firestore().collection("users").doc(userId).collection("availability").doc(date).delete();

        res.status(200).json({ message: "Availability deleted successfully" });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Get all dates with availability
app.get("/api/availability", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;

        // Query availability subcollection in Firestore
        const snapshot = await admin.firestore().collection("users").doc(userId).collection("availability").get();

        // Extract dates from snapshot
        const dates: any = {};
        snapshot.docs.map((doc) => {
            if (doc.data().availability.length) {
                dates[doc.id] = [{}];
            }
        });
        res.status(200).json({ data: dates });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

// Function to add a notification to Firestore
async function addNotification(userId: string, type: string, message: string) {
    const notification = {
        type,
        message,
        time: new Date().getTime(),
    };

    await admin.firestore().collection("users").doc(userId).collection("notifications").add(notification);
}

// Get notifications for the user
app.get("/api/notifications", verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = req.userId as string;

        // Query notifications subcollection in Firestore
        const snapshot = await admin.firestore().collection("users").doc(userId).collection("notifications").orderBy("time", "desc").get();

        // Extract notifications from snapshot
        const notifications = snapshot.docs.map((doc) => doc.data());

        res.status(200).json({ data: notifications });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

module.exports = app;
