
import React from 'react';
import { useMsal } from "@azure/msal-react";
import { loginRequest } from "../authConfig";
import { ShieldAlert, LogIn } from 'lucide-react';

const Login: React.FC = () => {
    const { instance } = useMsal();

    const handleLogin = () => {
        // Changed to loginPopup to support iframed/preview environments
        instance.loginPopup(loginRequest).catch(e => {
            console.error(e);
        });
    };

    return (
        <div className="min-h-screen bg-primary_1 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-500">
                <div className="p-12 text-center">
                    <div className="flex justify-center mb-8">
                        <div className="p-4 bg-primary_3/10 rounded-full">
                            <ShieldAlert className="text-primary_2 w-12 h-12" />
                        </div>
                    </div>
                    
                    <h1 className="text-3xl font-display font-bold text-primary_1 mb-2">LotUs. <span className="font-light text-primary_3">assist</span></h1>
                    <p className="text-gray-500 text-sm mb-10 leading-relaxed font-medium">
                        Welcome to your Digital IT Concierge. Please sign in with your Lotus Assist work account to continue.
                    </p>

                    <button 
                        onClick={handleLogin}
                        className="w-full py-4 bg-primary_1 text-white rounded-2xl font-display font-bold shadow-xl shadow-primary_1/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3"
                    >
                        <LogIn size={20} />
                        SIGN IN WITH MICROSOFT
                    </button>
                    
                    <div className="mt-8 pt-8 border-t border-gray-100">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                            Secure Enterprise Authentication Active
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Login;
