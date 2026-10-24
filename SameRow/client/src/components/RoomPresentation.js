import { createContext, useContext } from 'react';

export const RoomPresentation = createContext({ fullscreen: false, toggleFullscreen: null });
export const useRoomPresentation = () => useContext(RoomPresentation);
