import express, { Request, Response } from 'express';
import User, { IUser } from '../models/User';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import bcrypt from 'bcryptjs';
import { incrementPromptUsage, canMakePrompt } from '../middleware/monthlyReset';

const router = express.Router();

// Get user profile data
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    
    const profileData = {
      id: user._id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      phone: user.phone,
      faculty: user.faculty,
      academicYear: user.academicYear,
      major: user.major,
      semester: user.semester,
      selectedPlan: user.selectedPlan,
      weakPoints: user.weakPoints,
      profilePicture: user.profilePicture,
      isVerified: user.isVerified,
      colorMode: user.colorMode,
      chatFont: user.chatFont,
      dataCollection: user.dataCollection,
      chatHistory: user.chatHistory,
      analytics: user.analytics,
      marketingEmails: user.marketingEmails,
      totalConversations: user.totalConversations,
      promptsUsedThisMonth: user.promptsUsedThisMonth,
      monthlyPromptLimit: user.monthlyPromptLimit,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    res.json({ user: profileData });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile (excluding protected fields)
interface UpdateProfileBody {
  email?: string;
  phone?: string;
  colorMode?: 'dark' | 'light' | 'auto';
  chatFont?: 'system' | 'mono' | 'serif';
  dataCollection?: boolean;
  chatHistory?: boolean;
  analytics?: boolean;
  marketingEmails?: boolean;
  selectedPlan?: string;
}

router.put('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const updates: UpdateProfileBody = req.body;

    // Validate email if provided
    if (updates.email && updates.email !== user.email) {
      const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
      if (!emailRegex.test(updates.email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Check if email is already taken
      const existingUser = await User.findOne({ 
        email: updates.email.toLowerCase(),
        _id: { $ne: user._id }
      });
      
      if (existingUser) {
        return res.status(409).json({ error: 'Email already in use' });
      }
    }

    // Validate selectedPlan if provided
    if (updates.selectedPlan && !['basic', 'premium', 'pro', 'free', 'max'].includes(updates.selectedPlan)) {
      return res.status(400).json({ error: 'Invalid plan selection' });
    }

    // Validate colorMode if provided
    if (updates.colorMode && !['dark', 'light', 'auto'].includes(updates.colorMode)) {
      return res.status(400).json({ error: 'Invalid color mode' });
    }

    // Validate chatFont if provided
    if (updates.chatFont && !['system', 'mono', 'serif'].includes(updates.chatFont)) {
      return res.status(400).json({ error: 'Invalid chat font' });
    }

    // Prepare update object with only allowed fields
    const allowedUpdates: Partial<IUser> = {};
    
    if (updates.email !== undefined) allowedUpdates.email = updates.email.toLowerCase().trim();
    if (updates.phone !== undefined) allowedUpdates.phone = updates.phone.trim();
    if (updates.colorMode !== undefined) allowedUpdates.colorMode = updates.colorMode;
    if (updates.chatFont !== undefined) allowedUpdates.chatFont = updates.chatFont;
    if (updates.dataCollection !== undefined) allowedUpdates.dataCollection = updates.dataCollection;
    if (updates.chatHistory !== undefined) allowedUpdates.chatHistory = updates.chatHistory;
    if (updates.analytics !== undefined) allowedUpdates.analytics = updates.analytics;
    if (updates.marketingEmails !== undefined) allowedUpdates.marketingEmails = updates.marketingEmails;
    if (updates.selectedPlan !== undefined) allowedUpdates.selectedPlan = updates.selectedPlan;

    // Update monthly prompt limit based on plan
    if (updates.selectedPlan) {
      switch (updates.selectedPlan) {
        case 'free':
          allowedUpdates.monthlyPromptLimit = 10;
          break;
        case 'basic':
          allowedUpdates.monthlyPromptLimit = 100;
          break;
        case 'premium':
        case 'pro':
        case 'max':
          allowedUpdates.monthlyPromptLimit = -1; // Unlimited
          break;
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      allowedUpdates,
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const responseData = {
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      dateOfBirth: updatedUser.dateOfBirth,
      phone: updatedUser.phone,
      faculty: updatedUser.faculty,
      academicYear: updatedUser.academicYear,
      major: updatedUser.major,
      semester: updatedUser.semester,
      selectedPlan: updatedUser.selectedPlan,
      weakPoints: updatedUser.weakPoints,
      profilePicture: updatedUser.profilePicture,
      isVerified: updatedUser.isVerified,
      colorMode: updatedUser.colorMode,
      chatFont: updatedUser.chatFont,
      dataCollection: updatedUser.dataCollection,
      chatHistory: updatedUser.chatHistory,
      analytics: updatedUser.analytics,
      marketingEmails: updatedUser.marketingEmails,
      totalConversations: updatedUser.totalConversations,
      promptsUsedThisMonth: updatedUser.promptsUsedThisMonth,
      monthlyPromptLimit: updatedUser.monthlyPromptLimit,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    res.json({ 
      message: 'Profile updated successfully',
      user: responseData 
    });

  } catch (error: any) {
    console.error('Update profile error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({ error: messages.join(', ') });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change password
interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

router.put('/password', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    // Get user with password field
    const userWithPassword = await User.findById(user._id).select('+password');
    if (!userWithPassword) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isCurrentPasswordValid = await userWithPassword.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(12);
    const hashedNewPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    await User.findByIdAndUpdate(user._id, {
      password: hashedNewPassword
    });

    res.json({ message: 'Password changed successfully' });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update account stats (for internal use)
router.put('/stats', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { totalConversations, promptsUsedThisMonth } = req.body;

    const updates: Partial<IUser> = {};
    
    if (typeof totalConversations === 'number' && totalConversations >= 0) {
      updates.totalConversations = totalConversations;
    }
    
    if (typeof promptsUsedThisMonth === 'number' && promptsUsedThisMonth >= 0) {
      updates.promptsUsedThisMonth = promptsUsedThisMonth;
    }

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      updates,
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ 
      message: 'Stats updated successfully',
      totalConversations: updatedUser.totalConversations,
      promptsUsedThisMonth: updatedUser.promptsUsedThisMonth,
      monthlyPromptLimit: updatedUser.monthlyPromptLimit
    });

  } catch (error) {
    console.error('Update stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export user data
router.get('/export', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    
    const exportData = {
      profile: {
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        phone: user.phone,
        faculty: user.faculty,
        academicYear: user.academicYear,
        major: user.major,
        semester: user.semester,
        weakPoints: user.weakPoints,
        createdAt: user.createdAt
      },
      settings: {
        selectedPlan: user.selectedPlan,
        colorMode: user.colorMode,
        chatFont: user.chatFont,
        dataCollection: user.dataCollection,
        chatHistory: user.chatHistory,
        analytics: user.analytics,
        marketingEmails: user.marketingEmails
      },
      stats: {
        totalConversations: user.totalConversations,
        promptsUsedThisMonth: user.promptsUsedThisMonth,
        monthlyPromptLimit: user.monthlyPromptLimit
      },
      exportDate: new Date().toISOString()
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="faxdata_${user.username}_${new Date().toISOString().split('T')[0]}.json"`);
    res.json(exportData);

  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if user can make a prompt
router.get('/can-prompt', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const canPrompt = await canMakePrompt((user._id as any).toString());
    
    res.json({ 
      canPrompt,
      promptsUsedThisMonth: user.promptsUsedThisMonth,
      monthlyPromptLimit: user.monthlyPromptLimit
    });
  } catch (error) {
    console.error('Check prompt limit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Use a prompt (increment counter)
router.post('/use-prompt', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const success = await incrementPromptUsage((user._id as any).toString());
    
    if (!success) {
      return res.status(403).json({ error: 'Monthly prompt limit reached' });
    }

    // Get updated user data
    const updatedUser = await User.findById(user._id);
    
    res.json({ 
      message: 'Prompt usage recorded',
      promptsUsedThisMonth: updatedUser?.promptsUsedThisMonth,
      monthlyPromptLimit: updatedUser?.monthlyPromptLimit
    });
  } catch (error) {
    console.error('Use prompt error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Increment conversation count
router.post('/increment-conversations', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    
    await User.findByIdAndUpdate(user._id, {
      $inc: { totalConversations: 1 }
    });

    res.json({ message: 'Conversation count updated' });
  } catch (error) {
    console.error('Increment conversations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;