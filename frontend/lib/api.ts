import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api";

const api = axios.create({
    baseURL: API_URL,
    withCredentials: true, // send httpOnly auth cookie on every request
    headers: {
        'Content-Type': 'application/json',
    }
});

// Redirect to login on 401 (expired/invalid JWT)
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (
            error.response?.status === 401 &&
            typeof window !== 'undefined' &&
            window.location.pathname !== '/login'
        ) {
            localStorage.removeItem('user');
            window.location.href = '/login';
        }
        return Promise.reject(error);
    }
);

export default api;
