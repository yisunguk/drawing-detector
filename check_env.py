import os

def check_env():
    with open("backend/.env", "rb") as f:
        content = f.read()
        print(f"File size: {len(content)} bytes")
        
        has_bad = False
        for i, byte in enumerate(content):
            # Check for non-printable ASCII (excluding newline 10, return 13)
            if not (32 <= byte <= 126 or byte in [10, 13]):
                print(f"found bad char at index {i}: byte={byte} hex={hex(byte)}")
                has_bad = True
        
        if not has_bad:
            print("No non-printable chars found.")
        else:
            print("Bad chars found!")

if __name__ == "__main__":
    check_env()
