import os

def convert(name):
    os.system('convert ' + name + ' out.png')  # expect: SEC-011
    return 'ok'
