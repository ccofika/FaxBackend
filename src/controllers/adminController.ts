import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Admin } from '../models';

export const adminLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find admin by email and include password for verification
    const admin = await Admin.findOne({ email }).select('+password');
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if admin is active
    if (!admin.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Verify password
    const isPasswordValid = await admin.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    // Generate JWT token
    const token = jwt.sign(
      { 
        adminId: admin._id,
        email: admin.email,
        role: admin.role,
        type: 'admin'
      },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );

    // Return admin data without password
    const adminData = {
      id: admin._id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      role: admin.role,
      lastLogin: admin.lastLogin
    };

    res.status(200).json({
      success: true,
      message: 'Login successful',
      admin: adminData,
      token
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const adminLogout = async (req: Request, res: Response) => {
  try {
    // For JWT tokens, logout is handled client-side by removing the token
    // Here we could implement token blacklisting if needed
    
    res.status(200).json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const adminMe = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?.adminId;
    
    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    const adminData = {
      id: admin._id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      role: admin.role,
      lastLogin: admin.lastLogin
    };

    res.status(200).json({
      success: true,
      admin: adminData
    });

  } catch (error) {
    console.error('Admin me error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};