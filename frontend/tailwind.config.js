/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Noto Sans KR"', 'sans-serif'],
            },
            keyframes: {
                indeterminate: {
                    '0%': { transform: 'translateX(-100%)' },
                    '100%': { transform: 'translateX(100%)' },
                }
            },
            animation: {
                indeterminate: 'indeterminate 1.5s infinite linear',
            }
        },
    },
    plugins: [],
}
