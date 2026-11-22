class BrainModel:
    def __init__(self, name):
        self.name = name

    def describe(self):
        return f"Exploring brain biology: {self.name}"


model = BrainModel("Alzheimer's Research")
print(model.describe())
