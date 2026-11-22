
"""
Alyra Model
Educational Brain Research Analyzer

A simple Python module for organizing
and analyzing neuroscience research topics.
"""

class BrainResearch:
    def __init__(self):
        self.research_topics = {
            "APP": "Amyloid precursor protein and amyloid-beta",
            "MAPT": "Tau protein and neuronal stability",
            "TREM2": "Microglia and neuroinflammation",
            "SOD1": "Oxidative stress and cellular function"
        }

    def display_topics(self):
        print("\n=== ALYRA MODEL ===")
        print("Brain Research Explorer\n")

        for gene, description in self.research_topics.items():
            print(f"{gene}: {description}")

    def search_topic(self, gene):
        result = self.research_topics.get(gene.upper())

        if result:
            print(f"\nResearch topic: {gene.upper()}")
            print(result)
        else:
            print("\nTopic not found.")

    def count_topics(self):
        return len(self.research_topics)


if __name__ == "__main__":
    research = BrainResearch()

    research.display_topics()

    print(f"\nTotal research topics: {research.count_topics()}")

    research.search_topic("TREM2")
