import axios from 'axios';

function normalizeApiBase(url: string): string {
    const trimmed = url.replace(/\/+$/, '');
    return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

const API_URL = normalizeApiBase(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000');

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
