import jwt from 'jsonwebtoken';
import { IUser } from '../models/User';

export interface JwtPayload {
  userId: string;
  username: string;
  email: string;
}

export const generateToken = (user: IUser): string => {
  const payload: JwtPayload = {
    userId: (user._id as any).toString(),
    username: user.username,
    email: user.email
  };

  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: '30d'
  });
};

export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
};