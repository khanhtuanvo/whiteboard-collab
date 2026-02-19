import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { generateToken } from '../utils/jwt';

export class AuthService {
    async register(email: string, password: string, name: string){
        //Check if user exists
        const existingUser = await prisma.user.findUnique({
            where: {email}
        });
        
        if (existingUser){
            throw new Error('User already exists');
        }
        //Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        //Create user
        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                name
            },
            select: {
                id: true,
                email: true,
                name: true,
                createdAt: true
            }
        });

        const token = generateToken(user.id);
        return { user, token };

    }

    async login(email: string, password: string){
        //Find user
        const user = await prisma.user.findUnique({
            where: { email }
        });
        if (!user){
            throw new Error("Invalid credentials");
        }

        //Verify password
        const isValidPassword = await bcrypt.compare(password, user.passwordHash);
        if (!isValidPassword){
            throw new Error("Invalid credentials");
        }
        
        const token = generateToken(user.id);
        return {
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                avatarUrl: user.avatarUrl
            },
            token
        };
    
    }

    async getProfile(userId: string){
        const user = await prisma.user.findUnique({
            where: {id: userId},
            select: {
                id: true,
                email: true,
                name: true,
                avatarUrl: true,
                createdAt: true,
            }
        
        
        });

        if (!user) {
            throw new Error('User not found');
        }
        return user;
    }
}