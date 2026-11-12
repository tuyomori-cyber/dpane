"""Set up the controlling terminal in a fresh process before executing the shell."""
import fcntl
import os
import sys
import termios

os.setsid()
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.execv(sys.argv[1], [sys.argv[1], "-i"])
