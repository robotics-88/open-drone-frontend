# simple-drone-frontend

This repo contains a minimal web app for interacting with the high level capabilities of a drone running our open source drone control stack. New autonomous capabilities added to its state machine will show up in the launch menu.

## setup

Clone and install dependencies:
```
git clone https://github.com/robotics-88/simple-drone-frontend.git
cd simple-drone-frontend/
python -m venv myenv
source myenv/bin/activate
pip install -r requirements.txt
```

## run

Launch the web app:
```
cd simple-drone-frontend/
uvicorn main:app --reload --host 0.0.0.0 --port 8040
```
View here http://127.0.0.1:8040/