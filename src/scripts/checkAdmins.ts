import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Admin } from '../models';

// Load environment variables
dotenv.config();

const checkAdmins = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/faxit');
    
    console.log('Connected to MongoDB');

    // Find all admins
    const admins = await Admin.find({});
    console.log('Found admins:', admins.length);
    
    admins.forEach(admin => {
      console.log({
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role,
        isActive: admin.isActive,
        hasPassword: !!admin.password,
        createdAt: admin.createdAt
      });
    });

    // Test login for both admin users
    const testEmails = ['ccofika@gmail.com', 'cobanovicvanja@gmail.com'];
    const testPasswords = ['maksimgej', 'filippeder'];

    for (let i = 0; i < testEmails.length; i++) {
      const email = testEmails[i];
      const password = testPasswords[i];
      
      console.log(`\nTesting login for: ${email}`);
      
      const admin = await Admin.findOne({ email }).select('+password');
      if (admin) {
        const isValid = await admin.comparePassword(password);
        console.log(`Password valid: ${isValid}`);
      } else {
        console.log('Admin not found');
      }
    }
    
  } catch (error) {
    console.error('Error checking admins:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

if (require.main === module) {
  checkAdmins();
}

export default checkAdmins;