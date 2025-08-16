import express, { Request, Response } from 'express';
import User, { IUser } from '../models/User';
import { generateToken } from '../utils/jwt';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

interface RegisterBody {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  phone?: string;
  faculty?: string;
  academicYear?: string;
  major?: string;
  semester?: string;
  selectedPlan?: string;
  weakPoints?: string[];
}

interface LoginBody {
  login: string; // can be username or email
  password: string;
}

router.post('/register', async (req: Request<{}, {}, RegisterBody>, res: Response) => {
  try {
    const { 
      username, 
      email, 
      password, 
      firstName, 
      lastName, 
      dateOfBirth,
      phone,
      faculty,
      academicYear,
      major,
      semester,
      selectedPlan,
      weakPoints
    } = req.body;

    if (!username || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ 
        error: 'Username, email, password, first name, and last name are required' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'Password must be at least 6 characters long' 
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      if (existingUser.username === username) {
        return res.status(409).json({ error: 'Username already taken' });
      }
    }

    const userData: Partial<IUser> = {
      username: username.toLowerCase().trim(),
      email: email.toLowerCase().trim(),
      password,
      firstName: firstName.trim(),
      lastName: lastName.trim()
    };

    if (dateOfBirth) {
      const dob = new Date(dateOfBirth);
      if (dob >= new Date()) {
        return res.status(400).json({ error: 'Date of birth must be in the past' });
      }
      userData.dateOfBirth = dob;
    }

    if (phone) {
      userData.phone = phone.trim();
    }

    if (faculty) {
      userData.faculty = faculty.trim();
    }

    if (academicYear) {
      userData.academicYear = academicYear.trim();
    }

    if (major) {
      userData.major = major.trim();
    }

    if (semester) {
      userData.semester = semester.trim();
    }

    if (selectedPlan) {
      userData.selectedPlan = selectedPlan.trim();
    }

    if (weakPoints && Array.isArray(weakPoints)) {
      userData.weakPoints = weakPoints.map(point => point.trim()).filter(point => point.length > 0);
    }

    const user = new User(userData);
    await user.save();

    const token = generateToken(user);

    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      profilePicture: user.profilePicture,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };

    res.status(201).json({
      message: 'User registered successfully',
      user: userResponse,
      token
    });

  } catch (error: any) {
    console.error('Registration error:', error);
    
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({ 
        error: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists` 
      });
    }

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({ error: messages.join(', ') });
    }

    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

router.post('/login', async (req: Request<{}, {}, LoginBody>, res: Response) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ error: 'Login and password are required' });
    }

    const user = await User.findOne({
      $or: [
        { email: login.toLowerCase().trim() },
        { username: login.toLowerCase().trim() }
      ]
    }).select('+password');

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      profilePicture: user.profilePicture,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };

    res.json({
      message: 'Login successful',
      user: userResponse,
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    
    const userResponse = {
      id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      profilePicture: user.profilePicture,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };

    res.json({ user: userResponse });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authenticateToken, async (req: AuthRequest, res: Response) => {
  res.json({ message: 'Logout successful' });
});

export default router;