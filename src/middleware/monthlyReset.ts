import User from '../models/User';

// Middleware to check and reset monthly prompt usage
export const resetMonthlyPrompts = async () => {
  try {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    // Find users who haven't been reset this month
    const usersToReset = await User.find({
      $or: [
        { lastMonthlyReset: { $lt: firstDayOfMonth } },
        { lastMonthlyReset: { $exists: false } }
      ]
    });

    if (usersToReset.length > 0) {
      // Reset prompt counts for all users
      await User.updateMany(
        {
          $or: [
            { lastMonthlyReset: { $lt: firstDayOfMonth } },
            { lastMonthlyReset: { $exists: false } }
          ]
        },
        {
          promptsUsedThisMonth: 0,
          lastMonthlyReset: now
        }
      );

      console.log(`Reset monthly prompts for ${usersToReset.length} users`);
    }
  } catch (error) {
    console.error('Error resetting monthly prompts:', error);
  }
};

// Function to increment user's prompt usage
export const incrementPromptUsage = async (userId: string): Promise<boolean> => {
  try {
    const user = await User.findById(userId);
    if (!user) return false;

    // Check if user has reached their limit
    const promptLimit = user.monthlyPromptLimit ?? 10;
    if (promptLimit !== -1 && 
        (user.promptsUsedThisMonth || 0) >= promptLimit) {
      return false; // User has reached limit
    }

    // Increment usage
    await User.findByIdAndUpdate(userId, {
      $inc: { promptsUsedThisMonth: 1 }
    });

    return true;
  } catch (error) {
    console.error('Error incrementing prompt usage:', error);
    return false;
  }
};

// Function to check if user can make a prompt
export const canMakePrompt = async (userId: string): Promise<boolean> => {
  try {
    const user = await User.findById(userId);
    if (!user) return false;

    // Unlimited for premium plans
    const promptLimit = user.monthlyPromptLimit ?? 10;
    if (promptLimit === -1) return true;

    // Check if under limit
    return (user.promptsUsedThisMonth || 0) < promptLimit;
  } catch (error) {
    console.error('Error checking prompt limit:', error);
    return false;
  }
};