import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Admin } from '../models';

// Load environment variables
dotenv.config();

const seedAdmins = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/faxit');
    
    console.log('Connected to MongoDB');

    // Clear existing admins
    await Admin.deleteMany({});
    console.log('Cleared existing admins');

    // Create admin users
    const admins = [
      {
        email: 'ccofika@gmail.com',
        password: 'maksimgej',
        firstName: 'Admin',
        lastName: 'One',
        role: 'super_admin' as const
      },
      {
        email: 'cobanovicvanja@gmail.com',
        password: 'filippeder',
        firstName: 'Admin',
        lastName: 'Two',
        role: 'admin' as const
      }
    ];

    // Create admins one by one to trigger password hashing
    const createdAdmins = [];
    for (const adminData of admins) {
      const admin = new Admin(adminData);
      await admin.save();
      createdAdmins.push(admin);
    }
    console.log('Created admin users:', createdAdmins.map(admin => ({ 
      email: admin.email, 
      role: admin.role 
    })));

    console.log('Admin seeding completed successfully!');
    
  } catch (error) {
    console.error('Error seeding admins:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
};

if (require.main === module) {
  seedAdmins();
}

export default seedAdmins;