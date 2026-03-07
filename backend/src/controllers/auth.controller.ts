import {Request, Response} from 'express';
import { AuthService } from '../services/auth.service';
import { z } from 'zod';


const authService = new AuthService();

//Validation schemas
const updateProfileSchema = z.object({
    name: z.string().min(2).optional(),
    avatarUrl: z.string().url().optional(),
});

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(2)
})

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
})

export class AuthController {
    async register(req: Request, res: Response){
        try {
            const {email, password, name} = registerSchema.parse(req.body);
            const result = await authService.register(email, password, name);
            res.status(201).json(result);
        } catch (error) {
            if (error instanceof z.ZodError){
                return res.status(400).json({error: error.issues});
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(400).json({ error: message });
        }
    }

    async login(req: Request, res: Response){
        try {
            const {email, password} = loginSchema.parse(req.body);
            const result = await authService.login(email, password);
            res.json(result);
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: error.issues});
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(401).json({ error: message });
        }
    }

    async getProfile(req: Request, res: Response){
        try {
            const userId = (req as any).userId;
            const user = await authService.getProfile(userId);
            res.json(user);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(404).json({ error: message });
        }
    }

    async updateProfile(req: Request, res: Response){
        try {
            const userId = (req as any).userId;
            const data = updateProfileSchema.parse(req.body);
            const user = await authService.updateProfile(userId, data);
            res.json(user);
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({ error: error.issues });
            }
            const message = error instanceof Error ? error.message : 'Something went wrong';
            res.status(400).json({ error: message });
        }
    }
}
