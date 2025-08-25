declare global {
  namespace NodeJS {
    interface Global {
      abortProcessing?: boolean;
    }
  }
  
  var abortProcessing: boolean | undefined;
}

export {};