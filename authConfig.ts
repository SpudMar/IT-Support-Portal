
import { Configuration, LogLevel } from "@azure/msal-browser";

export const msalConfig: Configuration = {
    auth: {
        clientId: "e571f9a4-e53c-4976-ac11-7dc31fb9c9f5", 
        authority: "https://login.microsoftonline.com/465441b6-0e7b-4e7c-aa2f-d1d8da82b212", 
        redirectUri: window.location.origin, 
    },
    cache: {
        cacheLocation: "sessionStorage",
    },
    system: {
        loggerOptions: {
            loggerCallback: (level, message, containsPii) => {
                if (containsPii) return;
                switch (level) {
                    case LogLevel.Error: console.error(message); return;
                    case LogLevel.Warning: console.warn(message); return;
                }
            }
        }
    }
};

export const loginRequest = {
    scopes: ["User.Read"]
};
